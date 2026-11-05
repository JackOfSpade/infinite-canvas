import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { buildResumeDocument } from '../../electron/ipc/resumeHtml.js';
import { formatOriginalJobListingMarkdown } from '../../electron/ipc/applicationBundle.js';

const sourceUrl = 'https://careers.northwind.test/jobs/platform';
const officialApplyUrl = `${sourceUrl}/application`;
const job = { title: 'Platform Engineer', company: 'Northwind Labs', location: 'Lakeview, Canada',
  url: 'https://mirror.test/platform', snippet: 'The scraped listing describes dispatch services.', postedBy: 'Elm Talent' };
function inspect(officialPosting, callback, extra = {}) {
  const value = { ...job, ...extra, officialPosting };
  const dom = new JSDOM(buildResumeDocument({ resumeMainHtml: '<main class="page"><h1 class="name">Synthetic Candidate</h1></main>',
    downloadBundle: { jobUrl: value.url, officialPosting, postingVariants: value.postingVariants,
      jobMarkdown: formatOriginalJobListingMarkdown(value, { audience: 'bundle' }) } }));
  try { callback(dom.window.document, value); } finally { dom.window.close(); }
}

export default [
  {
    name: 'R4 bundle L2 and L4 open the official posting page ahead of the apply form while retaining listing text',
    run() {
      for (const level of ['L2', 'L4']) inspect({ level, sourceUrl, officialApplyUrl }, (document, value) => {
        const link = document.querySelector('.ic-job-posting-link');
        assert.equal(link.href, sourceUrl); assert.equal(link.textContent, 'View official job posting');
        assert.equal(link.target, '_blank'); assert.equal(link.rel, 'noopener noreferrer');
        const data = JSON.parse(document.getElementById('ic-application-bundle-data').textContent);
        assert.equal(data.jobUrl, job.url); assert.equal(data.officialPosting.sourceUrl, sourceUrl);
        assert.ok(data.jobMarkdown.includes(job.snippet));
        assert.ok(data.jobMarkdown.includes(`**Official posting:** <${sourceUrl}>`));
        assert.ok(!data.jobMarkdown.includes('**Listing URL:**') && !data.jobMarkdown.includes(job.url), 'the official posting is the only source shown');
        assert.ok(!data.jobMarkdown.includes('**Posted by:**') && !data.jobMarkdown.includes('**Source:**'));
        const prompt = formatOriginalJobListingMarkdown(value);
        assert.ok(!prompt.includes('**Official posting:**') && !prompt.includes('**Apply URL:**'));
        assert.ok(prompt.includes(`**Listing URL:** <${job.url}>`), 'the prompt to the AI still gets the listing');
      });
    },
  },
  {
    name: 'R4 bundle uses a validated official apply URL only when no official page is available and otherwise falls back to original',
    run() {
      inspect({ level: 'L4', officialApplyUrl }, document => {
        assert.equal(document.querySelector('.ic-job-posting-link').href, officialApplyUrl);
        assert.equal(document.querySelector('.ic-job-posting-link').textContent, 'View official job posting');
      });
      for (const metadata of [{ level: 'L2', sourceUrl: 'javascript:alert(1)', officialApplyUrl: 'https://user@private.test/apply' },
        { level: 'L5', sourceUrl, officialApplyUrl }, { level: 'L6', sourceUrl, officialApplyUrl }]) inspect(metadata, document => {
        assert.equal(document.querySelector('.ic-job-posting-link').href, job.url);
        assert.equal(document.querySelector('.ic-job-posting-link').textContent, 'View original job posting');
        assert.equal(JSON.parse(document.getElementById('ic-application-bundle-data').textContent).officialPosting, undefined);
      });
    },
  },
  {
    name: 'R4 bundle with an official posting shows only its link and no location-specific original links',
    run() {
      inspect({ level: 'L2', sourceUrl, officialApplyUrl }, document => {
        const links = [...document.querySelectorAll('.ic-job-posting-link')];
        assert.deepEqual(links.map(link => link.href), [sourceUrl]);
        assert.deepEqual(links.map(link => link.textContent), ['View official job posting']);
      }, { postingVariants: [{ location: 'Lakeview', url: 'https://mirror.test/lakeview' }, { location: 'Bayview', url: 'https://mirror.test/bayview' }] });
    },
  },
  {
    name: 'R4 bundle with no confirmed official posting shows exactly one original link and no location-specific links',
    run() {
      inspect({ level: 'L5', sourceUrl, officialApplyUrl }, document => {
        const links = [...document.querySelectorAll('.ic-job-posting-link')];
        assert.deepEqual(links.map(link => link.href), [job.url]);
        assert.deepEqual(links.map(link => link.textContent), ['View original job posting']);
        assert.equal(document.querySelector('.ic-job-posting-links'), null, 'no multi-link container');
      }, { postingVariants: [{ location: 'Lakeview', url: 'https://mirror.test/lakeview' }, { location: 'Bayview', url: 'https://mirror.test/bayview' }] });
    },
  },
];
