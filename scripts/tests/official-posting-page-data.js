import assert from 'node:assert/strict';
import { extractOfficialPostingPageData, isOfficialPostingDetailUrl } from '../../electron/ipc/officialPostingPageData.js';
import { extractOfficialPostingCandidates } from '../../electron/ipc/officialPostingExtractors.js';

const url = 'https://careers.northwind.test/jobs/engineering/canada/role/4455';
const envelope = (extra = {}, pageExtra = {}) => {
  const page = { url: '/jobs/engineering/canada/role/4455', props: { job_object: {
    unique_identifier: '4455', title: 'Synthetic Platform Builder', content: '<p>Build reliable systems and write tests.</p>',
    address: 'Canada', job_code: 'NW-55', application: '/jobs/apply/4455', live: 1, closed: null, deleted_at: null, ...extra,
  } }, ...pageExtra };
  return `<div data-page='${JSON.stringify(page).replaceAll("'", '&#39;')}'></div>`;
};
const parse = (body, extra = {}) => extractOfficialPostingPageData({ body, sourceUrl: url, employer: 'Northwind Labs', ...extra });
const prose = 'Responsibilities include building reliable systems, reviewing changes and documenting decisions. '.repeat(8);
const article = `<main><h1>Synthetic Platform Builder</h1><p>${prose}</p><span data-job-location>Canada</span><a href='/apply/4455'>Apply now</a></main>`;
const nativeUrl = 'https://jobs.northwind.test/en_US/careers/JobDetail/synthetic-platform-builder/4455';
const nativeApply = 'https://jobs.northwind.test/en_US/careers/ApplicationMethods?jobId=4455';
const nativeField = '<div class="article__content__view__field"><div class="article__content__view__field__label">Role ID</div><div class="article__content__view__field__value">4455</div></div>';
const nativeDescription = `<article class="article article--details"><div class="article__header"><h3>Description &amp; Requirements</h3></div><div class="article__content"><div class="article__content__view"><p>${prose}</p><p>End of the full role description.</p></div></div></article>`;
const native = `<link rel="canonical" href="${nativeUrl}"><meta property="og:url" content="${nativeUrl}"><meta property="og:title" content="Synthetic Platform Builder"><h1>Northwind Labs</h1><h2 class="banner__text__title">Synthetic Platform Builder</h2><main><article class="article article--details"><div class="article__header"><h3>General Information</h3></div><div class="article__content">${nativeField}<div class="article__content__view__field field--locations"><div class="article__content__view__field__value"><strong>Locations</strong>: Lakeview, Canada</div></div></div></article>${nativeDescription}<a href="${nativeApply}">Apply</a></main>`;
const queryUrl = 'https://careers.northwind.test/job-description?gh_jid=4455';
const queryCanonical = '<link rel="canonical" href="/job-description?gh_jid=4455">';
const queryForm = '<form data-job-id="4455"><input type="hidden" name="gh_jid" value="4455"><button type="submit">Submit application</button></form>';
const queryArticle = `${queryCanonical}<main><h1>Synthetic Platform Builder</h1><p>${prose}</p><section><h2>Apply for this role</h2>${queryForm}</section></main>`;
const currentUrl = 'https://careers.northwind.test/job/4455/synthetic-platform-builder/';
const currentApply = 'https://sjobs.brassring.com/TGnewUI/Search/home/HomeWithPreLoad?PageType=JobDetails&partnerid=123&siteid=456&jobid=789';
const currentJob = (extra = {}) => ({ id: 4455, company_name: 'Northwind Labs', title: 'Synthetic Platform Builder',
  ref: 'NW-55', clientid: 'NW-55', entity_status: 'Open', url: currentUrl, seo_url: currentApply,
  hidden: 'false', is_posted: 'true', publish_to_cws: 'true', location_type: 'Onsite',
  description: '<div data-field="description"><p>We build software for dispatch teams.</p></div>',
  responsibilities: `<div data-field="responsibilities"><p>${prose}</p><p>Preserve every source section.</p></div>`,
  qualifications: `<div data-field="qualifications"><p>${'Experience building reliable services and documenting operational decisions. '.repeat(7)}</p><p>Final qualification stays visible.</p></div>`,
  compensation: '<div data-field="compensation"><p>Posted compensation appears in the actual description.</p></div>', ...extra });
const currentPage = (extra = {}, schema = null) => {
  const job = currentJob(extra);
  const data = schema && { '@type': 'JobPosting', title: job.title, url: currentUrl,
    hiringOrganization: { '@type': 'Organization', name: 'Northwind Labs' },
    identifier: { '@type': 'PropertyValue', value: 'NW-55' }, description: '<p>Company boilerplate.</p>', ...schema };
  return `<link rel="canonical" href="${currentUrl}"><meta property="og:url" content="${currentUrl}">
    ${data ? `<script type="application/ld+json">${JSON.stringify(data)}</script>` : ''}
    <script>var current_job = ${JSON.stringify(job)};</script><main><h1>Synthetic Platform Builder</h1>
    <ul><li>Job ID: NW-55</li><li>Location: Lakeview, Canada</li><li>Work Setup: Onsite</li></ul>
    <section class="job-desc">${job.responsibilities}${job.qualifications}${job.compensation}</section>
    <section class="job-desc">${job.description}</section>
    <a class="apply-btn" aria-label="Apply for job on Brassring" href="${job.seo_url}">Use our legacy experience</a></main>`;
};
const currentParse = (body, extra = {}) => parse(body, { sourceUrl: currentUrl, ...extra });
const currentCandidates = (body, extra = {}) => extractOfficialPostingCandidates({ body, sourceUrl: currentUrl,
  employer: 'Northwind Labs', contentType: 'text/html', now: Date.UTC(2030, 0, 1), ...extra });

export default [
  {
    name: 'Native JSON assignments corroborate a complete DOM role without evaluating scripts or granting ownership',
    run() {
      const [result] = currentParse(currentPage());
      assert.equal(result.title, 'Synthetic Platform Builder'); assert.equal(result.identifier, 'NW-55');
      assert.equal(result.sourceUrl, currentUrl); assert.equal(result.officialApplyUrl, currentApply);
      assert.equal(result.location.display, 'Lakeview, Canada'); assert.equal(result.employer, 'Northwind Labs');
      assert.equal(result.live, true); assert.equal(result.isListed, true);
      for (const phrase of ['Responsibilities', 'Qualifications', 'Final qualification stays visible.',
        'Posted compensation appears in the actual description.', 'We build software for dispatch teams.']) assert.ok(result.description.includes(phrase), phrase);
      assert.equal(result.salary.provenance, 'unknown'); assert.equal(result.tenantProven, undefined);
      assert.equal(result.employerDomainProven, undefined); assert.equal(result.sameAs, '');
      const labelled = currentPage().replace('<div data-field="responsibilities">', '<div data-field="responsibilities"><h2 class="jd-field-label">Responsibilities</h2>');
      assert.equal(currentParse(labelled)[0].description, result.description, 'rendered field headings do not duplicate the corroborated body');
      assert.equal(currentParse(currentPage({ url: currentUrl.replace('synthetic-platform-builder', 'another-slug') }))[0].identifier, 'NW-55');
      const typographic = currentPage({ description: '<div data-field="description"><p>We build software for teams.</p> [#video#https://media.example/video/1?x=1&amp%3by=2{#550,300#}#/video#]</div>',
        responsibilities: `<div data-field="responsibilities"><p>You're part of this team. ${prose}</p></div>` })
        .replace("<section class=\"job-desc\"><div data-field=\"responsibilities\"><p>You're part of this team.",
          '<section class="job-desc"><div data-field="responsibilities"><p>You’re part of this team.')
        .replace('x=1&amp%3by=2{#550,300#}#/video#]</div></section>', 'x=1&amp;amp%3by=2{#550,300#}#/video#]</div></section>');
      const [normalized] = currentParse(typographic);
      assert.ok(normalized.description.includes('You’re part of this team.'));
      assert.ok(!normalized.description.includes('#video#')); assert.ok(!normalized.description.includes('media.example'));
    },
  },
  {
    name: 'Native work arrangements require corroborated actual labels and preserve unknown remote facts',
    run() {
      for (const [label, mode] of [['Remote', 'remote'], ['On-site', 'onsite'], ['Hybrid', 'hybrid']]) {
        const body = currentPage({ location_type: label }).replace('Work Setup: Onsite', `Work Setup: ${label}`);
        const [result] = currentParse(body); assert.equal(result.location.workMode, mode);
        assert.equal(result.location.remote, mode === 'remote');
      }
      const remote = currentPage({ location_type: 'Remote' }).replace('Work Setup: Onsite', 'Work Setup: Remote')
        .replace('Location: Lakeview, Canada', 'Location: Canada (Remote)');
      assert.equal(currentParse(remote)[0].location.remoteCountry, 'Canada');
      const cityRemote = remote.replace('Location: Canada (Remote)', 'Location: Lakeview (Remote)');
      assert.equal(currentParse(cityRemote)[0].location.remoteCountry, '', 'a city must not manufacture a country restriction');
      for (const body of [currentPage({ location_type: undefined }), currentPage().replace('<li>Work Setup: Onsite</li>', ''),
        currentPage({ location_type: 'Flexible' }).replace('Work Setup: Onsite', 'Work Setup: Flexible')]) {
        const [result] = currentParse(body); assert.equal(result.location.remote, undefined); assert.equal(result.location.workMode, '');
      }
      for (const body of [currentPage({ location_type: 'Remote' }),
        currentPage().replace('Work Setup: Onsite', 'Work Setup: Remote'),
        currentPage().replace('</ul>', '<li>Work Setup: Remote</li></ul>'),
        currentPage().replace('Location: Lakeview, Canada', 'Location: Canada (Remote)')]) assert.deepEqual(currentParse(body), []);
    },
  },
  {
    name: 'Native JSON assignment templates fail closed on conflicting identity incomplete DOM or unrelated application targets',
    run() {
      const valid = currentPage(); const job = currentJob();
      const failures = [currentPage({ id: 9999 }), currentPage({ company_name: 'Other Labs' }),
        currentPage({ ref: 'NW-99' }), currentPage({ title: 'Another Role' }), currentPage({ clientid: 'NW-99' }),
        currentPage({ url: currentUrl.replace('/4455/', '/9999/') }), currentPage({ entity_status: 'Maybe' }),
        currentPage({ is_posted: 'unknown' }), currentPage({ seo_url: 'https://unrelated.test/apply/4455' }),
        valid.replace(`href="${currentUrl}"`, `href="${currentUrl.replace('/4455/', '/9999/')}"`),
        valid.replace('Job ID: NW-55', 'Job ID: NW-99'), valid.replace('<h1>', '<h1>Another Role</h1><h1>'),
        valid.replace('aria-label="Apply for job on Brassring"', 'aria-label="Open careers"'),
        valid.replace(`href="${currentApply}"`, 'href="https://boards.greenhouse.io/other/jobs/9999"'),
        valid.replace('</main>', '<a class="apply-btn" href="https://unrelated.test/apply">Other</a></main>'),
        valid.replace('<script>var current_job', '<script type="text/plain">var current_job'),
        valid.replace('<script>var current_job', '<script src="/jobs.js">var current_job'),
        valid.replace(';</script>', '; globalThis.neverExecuteThis = true;</script>'),
        valid.replace('<script>var current_job = ', '<script>var current_job = (() => '),
        valid.replace('</main>', '<main>Another role</main></main>'),
        valid.replace(job.compensation + '</section>', '</section>'),
        valid.replace(job.qualifications + job.compensation, job.qualifications + job.qualifications + job.compensation),
        valid.replace('Preserve every source section.</p></div>', 'Replace actual duties.</p></div>')];
      for (let index = 0; index < failures.length; index++) assert.deepEqual(currentParse(failures[index]), [], `native binding case ${index}`);
      assert.deepEqual(currentParse(valid, { employer: '' }), []);
      assert.deepEqual(currentParse(valid, { employer: 'Other Labs' }), []);
      assert.equal(globalThis.neverExecuteThis, undefined);
    },
  },
  {
    name: 'Complete native role representation replaces only its exact JSON-LD role and never merges unrelated fields',
    run() {
      const [result] = currentCandidates(currentPage({}, { baseSalary: { '@type': 'MonetaryAmount', currency: 'CAD',
        value: { minValue: 111000, maxValue: 122000, unitText: 'YEAR' } } }));
      assert.ok(result.description.includes('Final qualification stays visible.'));
      assert.equal(result.officialApplyUrl, currentApply); assert.equal(result.location.display, 'Lakeview, Canada');
      assert.equal(result.salary.provenance, 'unknown', 'a different representation does not lend its other facts to the native body');
      for (const schema of [{ identifier: 'NW-99' }, { title: 'Another Role' },
        { hiringOrganization: { name: 'Other Labs' } }]) {
        const [unreplaced] = currentCandidates(currentPage({}, schema));
        assert.equal(unreplaced.description, 'Company boilerplate.');
        assert.equal(unreplaced.officialApplyUrl, currentUrl);
      }
      assert.ok(currentCandidates(currentPage({}, { url: undefined }))[0].description.includes('Final qualification stays visible.'),
        'one URLless JSON-LD role must still match the exact native route-bound title employer and requisition');
      const longer = 'Full structured qualifications and duties. '.repeat(100);
      assert.equal(currentCandidates(currentPage({}, { description: longer }))[0].description, longer.trim(),
        'an already fuller exact structured role remains whole');
    },
  },
  {
    name: 'Native preference preserves exact-role closure and expiry without treating expiration as closed',
    run() {
      for (const schema of [{ isListed: false }, { closed: true }, { status: 'Closed' }, { url: undefined, isListed: false },
        { description: '<p>This job is no longer available.</p>' }]) {
        const [result] = currentCandidates(currentPage({}, schema));
        assert.ok(result.description.includes('Final qualification stays visible.'));
        assert.equal(result.live, false); assert.equal(result.isListed, false);
      }
      const [expired] = currentCandidates(currentPage({}, { validThrough: '2000-01-01' }));
      assert.equal(expired.live, false); assert.equal(expired.isListed, true); assert.equal(expired.validThrough, '2000-01-01');
      const [future] = currentCandidates(currentPage({}, { validThrough: '2050-01-01' }));
      assert.equal(future.live, true); assert.equal(future.isListed, true); assert.equal(future.validThrough, '2050-01-01');
      for (const extra of [{ entity_status: 'Closed' }, { hidden: true }, { is_posted: false }, { publish_to_cws: 'false' }]) {
        const [result] = currentCandidates(currentPage(extra, {}));
        assert.equal(result.live, false); assert.equal(result.isListed, false);
      }
      const notice = currentPage({}, {}).replace('</main>', '<div class="job-notice">Position has been filled</div></main>');
      assert.equal(currentCandidates(notice)[0].live, false);
      const unrelated = currentPage({}, {}) + '<script type="application/ld+json">' + JSON.stringify({ '@type': 'JobPosting',
        title: 'Other Role', identifier: 'NW-99', url: currentUrl.replace('/4455/', '/9999/'),
        hiringOrganization: { name: 'Other Labs' }, description: 'Job is no longer available.', isListed: false }) + '</script>';
      assert.equal(currentCandidates(unrelated)[0].live, true, 'another role cannot close this fetched posting');
    },
  },
  {
    name: 'Native roles detail paths admit only positive numeric identities and the matching single public query ID',
    run() {
      for (const prefix of ['/careers/roles/', '/company/careers/roles/']) {
        const source = 'https://northwind.test' + prefix;
        for (const suffix of ['4455', '4455/', '4455?gh_jid=4455']) assert.equal(isOfficialPostingDetailUrl(source + suffix), true);
        for (const suffix of ['0', '04455', '4455/other', '4455?gh_jid=9999', '4455?gh_jid=4455&gh_jid=4455',
          '4455?gh_jid=4455&other=1', '4455#other']) assert.equal(isOfficialPostingDetailUrl(source + suffix), false, suffix);
        assert.deepEqual(parse(article, { sourceUrl: source + '4455' }), [], 'new typed roles routes cannot fall through to the generic H1 article parser');
      }
    },
  },
  {
    name: 'Query-backed job descriptions require a bound canonical and actual apply form without rewriting the source URL',
    run() {
      const [result] = parse(queryArticle, { sourceUrl: queryUrl });
      assert.equal(result.title, 'Synthetic Platform Builder'); assert.equal(result.identifier, '4455');
      assert.equal(result.sourceUrl, queryUrl); assert.equal(result.officialApplyUrl, queryUrl);
      assert.ok(result.description.includes(prose.trim())); assert.equal(result.live, true);
      assert.equal(result.tenantProven, undefined); assert.equal(result.employerDomainProven, undefined);
      assert.deepEqual(parse(queryArticle, { sourceUrl: queryUrl, employer: '' }), []);
      assert.equal(parse(queryArticle.replace('<form data-job-id="4455">', '<form action="/apply?jobId=4455">'), { sourceUrl: queryUrl }).length, 1);
      assert.equal(parse(queryArticle.replace(queryForm, '<form><button type="submit">Submit application</button></form>'), { sourceUrl: queryUrl }).length, 1,
        'a local form need not invent a job-ID field when its canonical already binds the actual page');
      const nativeQuery = 'https://careers.northwind.test/job-description/4455?gh_jid=4455';
      assert.equal(parse(queryArticle, { sourceUrl: nativeQuery }).length, 1,
        'existing numeric native paths may publish the matching query URL as canonical');
      for (const sourceUrl of [queryUrl + '&gh_jid=4455', queryUrl + '&jobId=9999', queryUrl + '&source=other',
        queryUrl.replace('4455', '0'), nativeQuery.replace('gh_jid=4455', 'gh_jid=9999'), nativeQuery + '&gh_jid=4455']) {
        assert.equal(isOfficialPostingDetailUrl(sourceUrl), false, sourceUrl);
        assert.deepEqual(parse(queryArticle, { sourceUrl }), []);
      }
    },
  },
  {
    name: 'Query-backed job descriptions reject conflicting canonical, form and multi-role declarations',
    run() {
      for (const body of [queryArticle.replace(queryCanonical, ''), queryArticle.replace(queryCanonical, queryCanonical + queryCanonical),
        queryArticle.replace(queryCanonical, queryCanonical.replace('4455', '9999')),
        queryArticle.replace(queryCanonical, queryCanonical.replace('/job-description?', 'https://unrelated.test/job-description?')),
        queryArticle.replace(queryCanonical, queryCanonical.replace('gh_jid=4455', 'gh_jid=4455&jobId=9999')),
        queryArticle.replace('data-job-id="4455"', 'data-job-id="9999"'), queryArticle.replace('value="4455"', 'value="9999"'),
        queryArticle.replace('<form data-job-id="4455">', '<form action="/apply?jobId=9999">'),
        queryArticle.replace('<form data-job-id="4455">', '<form action="/apply?jobId=4455&jobId=4455">'),
        queryArticle.replace('<form data-job-id="4455">', '<form action="/apply/9999">'),
        queryArticle.replace('<form data-job-id="4455">', '<form action="https://unrelated.test/apply?jobId=4455">'),
        queryArticle.replace(queryForm, '<a href="/apply/4455">Apply</a>'),
        queryArticle.replace('Submit application', 'Search'), queryArticle.replace(queryForm, queryForm + queryForm),
        queryArticle.replace('<h1>', '<h1>Another role</h1><h1>'), queryArticle.replace(prose, 'Short role text')]) {
        assert.deepEqual(parse(body, { sourceUrl: queryUrl }), []);
      }
    },
  },
  {
    name: 'Native JobDetail templates bind the actual role H2, route ID, apply target and complete description',
    run() {
      const [result] = parse(native, { sourceUrl: nativeUrl });
      assert.equal(result.title, 'Synthetic Platform Builder'); assert.notEqual(result.title, 'Northwind Labs');
      assert.equal(result.identifier, '4455'); assert.equal(result.employer, 'Northwind Labs');
      assert.equal(result.sourceUrl, nativeUrl); assert.equal(result.officialApplyUrl, nativeApply);
      assert.equal(result.location.display, 'Lakeview, Canada'); assert.equal(result.live, true);
      assert.ok(result.description.includes(prose.trim())); assert.ok(result.description.endsWith('End of the full role description.'));
      assert.equal(result.tenantProven, undefined); assert.equal(result.employerDomainProven, undefined);
      assert.equal(isOfficialPostingDetailUrl(nativeUrl), true);
      assert.equal(isOfficialPostingDetailUrl(`${nativeUrl}?jobId=4455`), true);
      assert.deepEqual(parse(native, { sourceUrl: nativeUrl, employer: '' }), []);
      for (const value of [nativeUrl.replace('/4455', ''), nativeUrl.replace('/4455', '/0'),
        `${nativeUrl}?jobId=9999`, `${nativeUrl}?jobId=4455&jobId=4455`]) assert.equal(isOfficialPostingDetailUrl(value), false);
    },
  },
  {
    name: 'Native JobDetail templates reject mismatched role declarations and unbound application links',
    run() {
      for (const body of [native.replace('>4455</div>', '>9999</div>'),
        native.replace(nativeField, ''), native.replace(nativeApply, nativeApply.replace('4455', '9999')),
        native.replace(nativeApply, nativeApply.replace('jobs.northwind.test', 'unrelated.test')),
        native.replace(nativeApply, `${nativeApply}&jobId=4455`), native.replace(nativeApply, 'javascript:alert(1)'),
        native.replace(`href="${nativeUrl}"`, `href="${nativeUrl.replace('4455', '9999')}"`),
        native.replace(`content="${nativeUrl}"`, `content="${nativeUrl.replace('jobs.northwind.test', 'unrelated.test')}"`),
        native.replace('content="Synthetic Platform Builder"', 'content="Unrelated Position"'),
        native.replace(`href="${nativeApply}"`, 'href="/en_US/careers"'),
        native.replace(prose, 'Short index text')]) assert.deepEqual(parse(body, { sourceUrl: nativeUrl }), []);
      const spoof = native.replace('>4455</div>', '>9999</div>').replace('<main>', '<main><h1>Fake job heading</h1>');
      assert.deepEqual(parse(spoof, { sourceUrl: nativeUrl }), [], 'a failed native binding cannot fall through to the generic H1 parser');
    },
  },
  {
    name: 'Native JobDetail templates reject ambiguous multi-role documents and permit duplicate identical apply buttons',
    run() {
      for (const body of [native.replace(nativeField, nativeField + nativeField),
        native.replace(nativeDescription, nativeDescription + nativeDescription),
        native.replace('</main>', '</main><main>Another role</main>'),
        native.replace('</h2>', '</h2><h2 class="banner__text__title">Another role</h2>'),
        native.replace('</main>', `<a href="${nativeApply.replace('4455', '9999')}">Apply</a></main>`)]) {
        assert.deepEqual(parse(body, { sourceUrl: nativeUrl }), []);
      }
      assert.equal(parse(native.replace('</main>', `<a href="${nativeApply}">Apply now</a></main>`), { sourceUrl: nativeUrl }).length, 1);
    },
  },
  {
    name: 'First-party numeric single-job templates render only one bound detail query',
    run() {
      const detail = 'https://careers.northwind.test/careers/single-job.html?job_id=4455';
      assert.equal(parse(article, { sourceUrl: detail })[0].sourceUrl, detail);
      for (const query of ['', '?job_id=4455&job_id=9999', '?job_id=4455&action=apply', '?job_id=../4455', '?job_id=0']) {
        assert.equal(isOfficialPostingDetailUrl('https://careers.northwind.test/careers/single-job.html' + query), false);
      }
    },
  },
  {
    name: 'First-party page data binds the exact Inertia detail record and keeps explicit status and source text',
    run() {
      const [result] = parse(envelope());
      assert.equal(result.title, 'Synthetic Platform Builder'); assert.equal(result.description, 'Build reliable systems and write tests.');
      assert.equal(result.employer, 'Northwind Labs'); assert.equal(result.identifier, 'NW-55'); assert.equal(result.location.display, 'Canada');
      assert.equal(result.sourceUrl, url); assert.equal(result.officialApplyUrl, 'https://careers.northwind.test/jobs/apply/4455');
      assert.equal(result.live, true); assert.equal(result.tenantProven, undefined); assert.equal(result.employerDomainProven, undefined);
      for (const extra of [{ live: 0 }, { closed: 'filled' }, { deleted_at: '2026-01-01' }]) assert.equal(parse(envelope(extra))[0].live, false);
    },
  },
  {
    name: 'First-party page data rejects unbound, ambiguous, employerless and unbounded application state',
    run() {
      for (const body of [envelope({ unique_identifier: '9999' }), envelope({}, { url: '/jobs/other/4455' }),
        envelope({}, { url: 'https://other.test/jobs/engineering/canada/role/4455' }), envelope({ live: undefined }),
        `${envelope()}${envelope()}`, '<div data-page="invalid"></div>']) assert.deepEqual(parse(body), []);
      assert.deepEqual(parse(envelope(), { employer: '' }), []);
      const stated = envelope().replace('"job_object":', '"tenantConfig":{"branding":{"customer_name":"Northwind Labs"}},"job_object":');
      assert.equal(parse(stated, { employer: '' })[0].employer, 'Northwind Labs', 'typed first-party branding remains an unproved source candidate');
      assert.deepEqual(parse('x'.repeat(3 * 1024 * 1024 + 1)), []);
      assert.deepEqual(parse(envelope({ application: 'javascript:alert(1)' })), []);
    },
  },
  {
    name: 'First-party DOM parsing requires a single detailed job article with heading, duties and an apply action',
    run() {
      const [result] = parse(article);
      assert.equal(result.title, 'Synthetic Platform Builder'); assert.equal(result.location.display, 'Canada'); assert.equal(result.live, true);
      assert.equal(isOfficialPostingDetailUrl(url), true); assert.equal(isOfficialPostingDetailUrl('https://careers.northwind.test/jobs'), false);
      for (const body of [article.replace('<main>', '<div>').replace('</main>', '</div>'), article.replace(/<a[\s\S]*?<\/a>/u, ''),
        article.replace('<h1>', '<h1>Other</h1><h1>'), article.replace(prose, 'Short index text')]) assert.deepEqual(parse(body), []);
      assert.deepEqual(parse(article, { sourceUrl: 'https://careers.northwind.test/jobs' }), []);
      const local = article.replace("<a href='/apply/4455'>Apply now</a>", '<section>Apply for this role<form><button>Submit application</button></form></section>');
      assert.equal(parse(local, { sourceUrl: 'https://careers.northwind.test/job-description/4455' })[0].officialApplyUrl, 'https://careers.northwind.test/job-description/4455');
    },
  },
];
