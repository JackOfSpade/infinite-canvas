import assert from 'node:assert/strict';
import { officialPostingVendorRoute as route, officialPostingVendorAdapterUrl as adapter,
  extractOfficialPostingVendorCandidates as extract, extractOfficialPostingVendorAccountReceipt as accountReceipt } from '../../electron/ipc/officialPostingVendorAdapters.js';

const employer = 'Synthetic Systems';
const id = '10000000-0000-4000-8000-000000000001';
const prose = '<h2>Responsibilities</h2><p>Build and operate product APIs with the engineering team.</p><h2>Requirements</h2><p>Experience designing distributed systems and accessible interfaces.</p>';
const parse = (body, sourceUrl, options = {}) => extract({ body: typeof body === 'string' ? body : JSON.stringify(body), sourceUrl, employer, ...options });
const jsonld = (values = {}) => `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title: 'Product Engineer', description: prose,
  hiringOrganization: { name: employer }, ...values })}</script>`;

export default [
  { name: 'vendor routes recognize employer-linked tenants without granting ownership', run() {
    const samples = [
      ['https://synthetic.bamboohr.com/careers/12', 'bamboohr', 'synthetic'],
      ['https://apply.workable.com/synthetic/j/ABC123/', 'workable', 'synthetic'],
      ['https://jobs.workable.com/company/Public123/jobs-at-synthetic', 'workable-public', 'Public123'],
      ['https://synthetic.wd2.myworkdayjobs.com/en-US/Public/job/City/Product-Engineer_JREQ123', 'workday', 'synthetic/public'],
      [`https://ats.rippling.com/en-US/synthetic/jobs/${id}`, 'rippling', 'synthetic'],
      ['https://synthetic.applytojob.com/apply/AbC123/Product-Engineer', 'jazzhr', 'synthetic'],
      ['https://jobs.gem.com/synthetic/AbC123', 'gem', 'synthetic'],
      [`https://recruiting.paylocity.com/Recruiting/Jobs/All/${id}`, 'paylocity', id],
      ['https://career4.successfactors.com/career?company=SYNTHETIC&career_ns=job_listing&career_job_req_id=12', 'successfactors', 'synthetic'],
    ];
    for (const [value, ats, tenant] of samples) assert.deepEqual(route(value), { ats, tenant });
    for (const value of ['http://synthetic.bamboohr.com/careers/12', 'https://user@synthetic.bamboohr.com/careers/12',
      'https://synthetic.bamboohr.com.evil.test/careers/12', 'https://jobs.gem.com/synthetic/a%2Fb',
      'https://synthetic.wd2.myworkdayjobs.com/job/123', 'https://synthetic.wd2.myworkdayjobs.com/en-US/jobs/123',
      'https://synthetic.wd2.myworkdayjobs.com/wday/cxs/synthetic/careers/job/123',
      'https://career4.successfactors.com/career?company=one&company=two']) assert.equal(route(value), null);
    assert.deepEqual(route('https://synthetic.wd2.myworkdayjobs.com/External_Career_Site/job/123'), { ats: 'workday', tenant: 'synthetic/external_career_site' });
  } },
  { name: 'public adapters preserve exact posting identity and reject supplied tenant mismatches', run() {
    const u = 'https://apply.workable.com/synthetic/j/aBc123/';
    assert.equal(adapter(route(u), u), 'https://apply.workable.com/api/v2/accounts/synthetic/jobs/aBc123');
    assert.equal(adapter({ ats: 'workable', tenant: 'foreign' }, u), '');
    const wd = 'https://synthetic.wd2.myworkdayjobs.com/en-US/Public/job/City/Product-Engineer_JREQ123';
    assert.equal(adapter(route(wd), wd), 'https://synthetic.wd2.myworkdayjobs.com/wday/cxs/synthetic/Public/job/City/Product-Engineer_JREQ123');
    const b = 'https://synthetic.bamboohr.com/careers/12';
    assert.equal(adapter(route(b), b), `${b}/detail`);
    assert.equal(adapter(route(b), `${b}/detail`), '');
  } },
  { name: 'Workday public apply landing URLs derive only the existing exact posting GET adapter', run() {
    for (const locale of ['', 'en-US/']) {
      const detail = `https://synthetic.wd2.myworkdayjobs.com/${locale}Public/job/City/Product-Engineer_JREQ123`;
      const expected = 'https://synthetic.wd2.myworkdayjobs.com/wday/cxs/synthetic/Public/job/City/Product-Engineer_JREQ123';
      for (const suffix of ['/apply', '/apply/', '/apply?source=public-board']) {
        const source = detail + suffix;
        assert.equal(adapter(route(source), source), expected);
      }
      assert.equal(adapter(route(detail), detail), expected, 'ordinary detail routes retain their existing adapter');
      const [parsed] = parse({ jobPostingInfo: { title: 'Product Engineer', jobPostingId: 'Product-Engineer_JREQ123',
        jobReqId: 'JREQ123', jobDescription: prose, location: 'Example City', posted: true, canApply: true, externalUrl: detail } }, expected);
      assert.equal(parsed.sourceUrl, detail); assert.equal(parsed.identifier, 'JREQ123'); assert.equal(parsed.live, true);
      assert.equal(parsed.tenantProven, undefined); assert.equal(parsed.employerDomainProven, undefined);
    }
  } },
  { name: 'Workday apply adapter rejects malformed nested actions, encoded separators and spoofed tenants', run() {
    const detail = 'https://synthetic.wd2.myworkdayjobs.com/en-US/Public/job/City/Product-Engineer_JREQ123';
    const expected = route(detail);
    for (const source of [`${detail}/apply/apply`, `${detail}/apply/Other_JREQ999`, `${detail}/Apply/Other_JREQ999`,
      `${detail}/apply//`, `${detail}/%61pply`, `${detail}/apply/extra`, detail.replace('job/City/', 'job/City%2FElsewhere/') + '/apply',
      detail.replace('job/City/', 'job/City%5CElsewhere/') + '/apply', detail.replace('Product-Engineer_JREQ123', 'Product-Engineer') + '/apply',
      detail.replace('job/City/Product-Engineer_JREQ123', 'job') + '/apply',
      detail.replace('synthetic.wd2', 'foreign.wd2') + '/apply', detail.replace('/Public/', '/Private/') + '/apply',
      detail.replace('myworkdayjobs.com', 'myworkdayjobs.com.foreign.test') + '/apply']) {
      assert.equal(adapter(expected, source), '', source);
    }
  } },
  { name: 'BambooHR requires its share URL to bind the response to the fetched numeric posting', run() {
    const source = 'https://synthetic.bamboohr.com/careers/12/detail';
    const opening = { jobOpeningShareUrl: source.replace('/detail', ''), jobOpeningName: 'Product Engineer',
      jobOpeningStatus: 'Open', atsLocation: { city: 'Example City', country: 'Canada' }, description: prose };
    const parsed = parse({ result: { jobOpening: opening } }, source)[0];
    assert.equal(parsed.identifier, '12'); assert.equal(parsed.live, true); assert.equal(parsed.location.display, 'Example City, Canada');
    assert.equal(parsed.employerDomainProven, undefined); assert.equal(parsed.tenantProven, undefined);
    assert.equal(parse({ result: { jobOpening: { ...opening, jobOpeningShareUrl: 'https://foreign.bamboohr.com/careers/12' } } }, source).length, 0);
    assert.equal(parse({ result: { jobOpening: { ...opening, jobOpeningStatus: 'Closed' } } }, source)[0].live, false);
  } },
  { name: 'Workable binds shortcode, retains complete sections and preserves explicit publication and pay facts', run() {
    const source = 'https://apply.workable.com/api/v2/accounts/synthetic/jobs/ABC123';
    const job = { shortcode: 'ABC123', title: 'Product Engineer', state: 'published', remote: true,
      description: prose, requirements: '<p>Unique qualification</p>', benefits: '<p>Posted benefit</p>', accountUid: id,
      locations: [{ city: 'Example City', country: 'Canada' }], salary_from: 100, salary_to: 200, salary_currency_iso_code: 'CAD', salary_frequency: 'year' };
    const parsed = parse(job, source)[0];
    assert.match(parsed.description, /Unique qualification/); assert.match(parsed.description, /Posted benefit/);
    assert.equal(parsed.salary.text, 'CAD 100 - 200/yr'); assert.equal(parsed.location.remote, true);
    assert.equal(parsed.accountUid, id);
    assert.equal(parse({ ...job, accountUid: { toString: id } }, source)[0].accountUid, undefined);
    assert.equal(parse({ ...job, shortcode: 'OTHER' }, source).length, 0);
    assert.equal(parse({ ...job, isInternal: true }, source)[0].live, false);
    assert.equal(parse({ ...job, state: 'closed' }, source)[0].live, false);
  } },
  { name: 'Workable public account receipts bind the exact company state key and typed account UUID without proving ownership', run() {
    const source = 'https://jobs.workable.com/company/Public123/jobs-at-synthetic';
    const company = { id, workableUid: id, title: employer, url: source, isHidden: false };
    const page = state => `<script>window.jobBoard = { supportedLanguages: [{"code":"en"}], initialState: ${JSON.stringify(state)} };</script>`;
    const receipt = (data = company, key = 'api/v1/companies/Public123', status = 200) => accountReceipt({ sourceUrl: source, body: page({ [key]: { status, data } }) });
    assert.deepEqual(receipt(), { ats: 'workable', accountUid: id, publicBoardUrl: source, employer, sourceUrl: source });
    assert.equal(receipt().tenantProven, undefined);
    assert.equal(receipt(company, 'api/v1/companies/Related456'), null);
    assert.equal(receipt({ ...company, workableUid: id.replace('001', '002') }), null);
    assert.equal(receipt({ ...company, id: 'untyped-account' }), null);
    assert.equal(receipt({ ...company, url: source.replace('Public123', 'Related456') }), null);
    assert.equal(receipt({ ...company, url: source.replace('jobs.workable.com', 'foreign.test') }), null);
    assert.equal(receipt({ ...company, isHidden: true }), null);
    assert.equal(receipt(company, 'api/v1/companies/Public123', 401), null);
    assert.equal(accountReceipt({ sourceUrl: source.replace('Public123', 'Related456'), body: page({ 'api/v1/companies/Public123': { status: 200, data: company } }) }), null);
  } },
  { name: 'Workable account state is parsed as bounded data and never borrowed from other globals or reassigned scripts', run() {
    const source = 'https://jobs.workable.com/company/Public123/jobs-at-synthetic';
    const state = JSON.stringify({ 'api/v1/companies/Public123': { status: 200, data: { id, workableUid: id, title: employer, url: source } } });
    const content = `window.jobBoard = { initialState: ${state} };`;
    const read = body => accountReceipt({ sourceUrl: source, body });
    assert.equal(read(`<script>window.unrelated = { initialState: ${state} };</script>`), null);
    assert.equal(read(`<script src="/bundle.js">${content}</script>`), null);
    assert.equal(read(`<script>${content}</script><script>${content}</script>`), null);
    assert.equal(read(`<script>${content} window.jobBoard = {};</script>`), null);
    assert.equal(read('<script>window.jobBoard = { initialState: (() => { throw new Error("must not run"); })() };</script>'), null);
    assert.equal(read('<script>window.jobBoard = { initialState: {unquoted: true} };</script>'), null);
    assert.equal(read(`<script>window.jobBoard = { nested: { initialState: ${state} } };</script>`), null);
    assert.equal(read(`<script>window.jobBoard = { someinitialState: ${state} };</script>`), null);
    assert.throws(() => read('x'.repeat(3 * 1024 * 1024 + 1)));
  } },
  { name: 'Workday rejects foreign external URLs and mismatched requisitions instead of adopting another posting', run() {
    const source = 'https://synthetic.wd2.myworkdayjobs.com/wday/cxs/synthetic/Public/job/City/Product-Engineer_JREQ123';
    const info = { title: 'Product Engineer', jobPostingId: 'Product-Engineer_JREQ123', jobReqId: 'JREQ123',
      jobDescription: prose, location: 'Example City', posted: true, canApply: true,
      externalUrl: 'https://synthetic.wd2.myworkdayjobs.com/en-US/Public/job/City/Product-Engineer_JREQ123' };
    assert.equal(parse({ jobPostingInfo: info }, source)[0].identifier, 'JREQ123');
    assert.equal(parse({ jobPostingInfo: { ...info, canApply: false } }, source)[0].live, false);
    for (const overrides of [{ jobReqId: 'R999' }, { jobPostingId: 'Other_R999' },
      { externalUrl: info.externalUrl.replace('synthetic.wd2', 'foreign.wd2') },
      { externalUrl: info.externalUrl.replace('/Public/', '/Private/') }]) assert.deepEqual(parse({ jobPostingInfo: { ...info, ...overrides } }, source), []);
  } },
  { name: 'Rippling uses exact Next data identity and ignores application fields and unrelated scripts', run() {
    const source = `https://ats.rippling.com/synthetic/jobs/${id}`;
    const job = { uuid: id, name: 'Product Engineer', url: source, companyName: employer,
      description: { company: '<p>Company context</p>', role: prose }, workLocations: ['Example City'], activeJobApplication: { questions: ['private candidate form'] } };
    const page = (post, board = { slug: 'synthetic' }) => `<script>throw new Error('must not run')</script><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { apiData: { jobBoard: board, jobPost: post } } } })}</script>`;
    const parsed = parse(page(job), source)[0]; assert.equal(parsed.live, true);
    assert.match(parsed.description, /Company context/); assert.doesNotMatch(parsed.description, /private candidate form/);
    assert.deepEqual(parse(page(job, { slug: 'foreign' }), source), []);
    assert.deepEqual(parse(page({ ...job, uuid: id.replace('001', '002') }), source), []);
    assert.equal(parse(page({ ...job, unlistedFromSearch: true }), source)[0].live, false);
  } },
  { name: 'Gem only derives a fixed public read-only query and binds returned external ID', run() {
    const source = 'https://jobs.gem.com/synthetic/AbC123'; const api = adapter(route(source), source);
    assert.equal(route(api).tenant, 'synthetic');
    const parsedUrl = new URL(api);
    assert.doesNotMatch(parsedUrl.searchParams.get('query'), /application|candidate|question|mutation/iu);
    const job = { extId: 'AbC123', title: 'Product Engineer', descriptionHtml: prose, jobPostSectionHtml: { introHtml: '<p>Intro</p>', outroHtml: '<p>Outro</p>' },
      isUnlistedExternally: false, locations: [{ name: 'Example City' }], job: { requisitionId: 'R1', teamDisplayName: employer } };
    assert.match(parse({ data: { oatsExternalJobPosting: job } }, api)[0].description, /Outro/);
    assert.equal(parse({ data: { oatsExternalJobPosting: { ...job, isUnlistedExternally: true } } }, api)[0].live, false);
    assert.deepEqual(parse({ data: { oatsExternalJobPosting: { ...job, extId: 'Foreign' } } }, api), []);
    parsedUrl.searchParams.set('query', 'query { candidate { email } }'); assert.equal(route(parsedUrl.href), null);
  } },
  { name: 'JazzHR and Paylocity bind JSON-LD to exact detail and unique fetched tenant navigation', run() {
    const jazz = 'https://synthetic.applytojob.com/apply/AbC123/Product-Engineer';
    assert.equal(parse(jsonld({ url: jazz }), jazz)[0].tenant, 'synthetic');
    assert.deepEqual(parse(jsonld({ url: jazz.replace('AbC123', 'OTHER') }), jazz), []);
    const pay = 'https://recruiting.paylocity.com/Recruiting/Jobs/Details/12';
    const nav = `<a href="/Recruiting/Jobs/All/${id}">All Jobs</a>`;
    const page = nav + jsonld({ url: pay }); assert.equal(route(pay, { html: page }).tenant, id);
    assert.equal(route(pay, { html: `<a href="https://[">Malformed navigation</a>${page}` }).tenant, id);
    assert.equal(parse(page, pay)[0].sourceUrl, pay);
    assert.equal(route(pay), null);
    assert.equal(route(pay, { html: `${page}<a href="/Recruiting/Jobs/All/${id.replace('001', '002')}">Other</a>` }), null);
  } },
  { name: 'SuccessFactors requires its exact requisition heading and scoped posting body', run() {
    const source = 'https://career4.successfactors.com/career?company=SYNTHETIC&career_ns=job_listing&career_job_req_id=12';
    const page = `<h1 id="candidateProfileTitle">Career Opportunities: Product Engineer (12)</h1><div class="joqReqDescription"><div class="externalPosting"><p><strong>Product Engineer</strong><br><strong>Example City</strong></p>${prose}</div></div><p>Unrelated navigation</p>`;
    const parsed = parse(page, source)[0]; assert.equal(parsed.identifier, '12'); assert.equal(parsed.location.display, 'Example City');
    assert.doesNotMatch(parsed.description, /Unrelated navigation/);
    assert.deepEqual(parse(page.replace('(12)', '(13)'), source), []);
    assert.deepEqual(parse(page.replace('externalPosting', 'unrelated'), source), []);
  } },
  { name: 'vendor parsers reject oversized, nul-containing, deeply nested and foreign-tenant bytes', run() {
    const source = 'https://synthetic.bamboohr.com/careers/12/detail';
    assert.throws(() => parse('x'.repeat(3 * 1024 * 1024 + 1), source));
    assert.throws(() => parse('\0', source));
    assert.deepEqual(parse('{}', source, { tenant: 'foreign' }), []);
    const body = { result: { jobOpening: { jobOpeningShareUrl: source.replace('/detail', ''), jobOpeningName: 'Engineer', jobOpeningStatus: 'Open',
      description: '<div>'.repeat(55) + 'Text' + '</div>'.repeat(55) } } };
    assert.throws(() => parse(body, source));
  } },
];
