import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import { formatOriginalJobListingMarkdown, ORIGINAL_JOB_LISTING_BODY_HEADING } from '../../electron/ipc/applicationBundle.js';
import { buildResumeDocument } from '../../electron/ipc/resumeHtml.js';
import { captureInterviewPreparationBundle } from '../../electron/ipc/interviewPreparation.js';
import { applicationDockRequest, brokenApplicationDockRequest, workingApplicationDockRequest } from '../../src/utils/applicationHandoffDock.js';

const job = {
  title: 'Platform Engineer', company: 'Northwind', location: 'Toronto, Ontario, Canada', salary: 'C$140,000 per year',
  url: 'https://board.example.test/jobs/one', snippet: 'Own reliable systems and maintain the platform.',
  postedBy: 'Recruiter * Team', applyUrl: 'https://careers.northwind.example/jobs/one',
  officialPosting: { level: 'L3', outcome: 'found', employer: 'Northwind', officialApplyUrl: 'https://careers.northwind.example/jobs/one', trail: ['structured-proof'] },
  postingVariants: [{ location: 'Toronto', url: 'https://board.example.test/jobs/one' }, { location: 'Ottawa', url: 'https://board.example.test/jobs/two' }],
};

export default [
  {
    name: 'Official posting bundle: prompt audience remains byte-identical to the legacy listing without poster or official-link metadata',
    run() {
      const { postedBy: _postedBy, applyUrl: _applyUrl, officialPosting: _officialPosting, ...legacy } = job;
      const expected = formatOriginalJobListingMarkdown(legacy);
      assert.equal(formatOriginalJobListingMarkdown(job), expected);
      assert.equal(formatOriginalJobListingMarkdown(job, { audience: 'prompt' }), expected);
      assert.equal(formatOriginalJobListingMarkdown(job, { audience: 'unsupported' }), expected);
      assert.ok(!expected.includes('Recruiter')); assert.ok(!expected.includes('careers.northwind.example'));
      assert.ok(!expected.includes('structured-proof')); assert.ok(!expected.includes('**Source level:**'));
      assert.ok(expected.includes(ORIGINAL_JOB_LISTING_BODY_HEADING)); assert.equal(expected.split(job.snippet).length, 2);
    },
  },
  {
    name: 'Official posting bundle: saved listing adds escaped provenance above the unchanged separator and scraped listing URL',
    run() {
      const markdown = formatOriginalJobListingMarkdown(job, { audience: 'bundle' });
      const [header, body] = markdown.split('\n---\n');
      assert.ok(header.includes('**Posted by:** Recruiter \\* Team'));
      assert.ok(header.includes(`**Apply URL:** <${job.applyUrl}>`));
      assert.ok(header.includes('**Source level:** L3: Employer\'s ATS'));
      assert.ok(header.includes(`**Listing URL:** <${job.url}>`));
      assert.ok(body.includes(ORIGINAL_JOB_LISTING_BODY_HEADING)); assert.ok(body.includes(job.snippet));
      assert.ok(body.includes('## Posting locations') && body.includes('**Ottawa:** <https://board.example.test/jobs/two>'));
      const unsafe = formatOriginalJobListingMarkdown({ ...job, applyUrl: 'https://secret@careers.example.test/one', officialPosting: { level: '__proto__' } }, { audience: 'bundle' });
      assert.ok(!unsafe.includes('Apply URL') && !unsafe.includes('Source level') && !unsafe.includes('secret'));
      const absent = formatOriginalJobListingMarkdown({ title: 'Legacy role', snippet: 'Legacy body' }, { audience: 'bundle' });
      assert.equal(absent, formatOriginalJobListingMarkdown({ title: 'Legacy role', snippet: 'Legacy body' }));
    },
  },
  {
    name: 'Official posting bundle: actual prompt quote source keeps employer-unknown listings free of poster and resolution scaffolding',
    async run() {
      const source = await fs.readFile(new URL('../../electron/ipc/localAiApplication.js', import.meta.url), 'utf8');
      const start = source.indexOf('function jobListingQuoteSource(');
      const end = source.indexOf('\n}', start) + 2;
      assert.ok(start >= 0 && end > start);
      const quoteSource = runInNewContext(`(${source.slice(start, end)})`, { formatOriginalJobListingMarkdown, cleanFrozenSourceText: text => text });
      const unknown = { ...job, company: '', postedBy: 'Unique Recruiting Poster', officialPosting: { ...job.officialPosting, level: 'L6', employer: '' } };
      const listing = quoteSource(unknown);
      assert.ok(listing.includes('**Company:** Unknown company'));
      assert.ok(!listing.includes('Unique Recruiting Poster')); assert.ok(!listing.includes('**Apply URL:**'));
      assert.ok(!listing.includes('**Source level:**')); assert.ok(!listing.includes('structured-proof'));
      assert.ok(source.includes('const posting = jobListingQuoteSource(input.job);'));
      assert.ok(source.includes("formatOriginalJobListingMarkdown(input.job, { audience: 'bundle' })"));
      assert.ok(source.includes("downloadBundle: { company: input.job?.company || input.job?.postedBy || ''"));
      assert.ok(source.includes("jobUrl: input.job?.applyUrl || input.job?.url || ''"));
      assert.ok(source.includes("jobContext: { title: input.job?.title || '', company: input.job?.company || '', location: input.job?.location || '' }"));
    },
  },
  {
    name: 'Official posting bundle: download metadata may name the poster while documents retain the unknown employer and official opening link',
    run() {
      const unknown = { ...job, company: '', postedBy: 'Unique Recruiting Poster', postingVariants: [], officialPosting: { ...job.officialPosting, level: 'L6', employer: '' } };
      const html = buildResumeDocument({
        resumeMainHtml: '<main class="page"><h1 class="name">Synthetic Candidate</h1><p>Candidate experience.</p></main>',
        docId: 'official-bundle-synthetic', coverLetter: { name: 'Synthetic Candidate', greeting: 'Dear Hiring Team,', paragraphs: ['I would welcome a discussion.'] },
        jobContext: { title: unknown.title, company: unknown.company, location: unknown.location },
        downloadBundle: { company: unknown.company || unknown.postedBy, candidateName: 'Synthetic Candidate',
          jobUrl: unknown.applyUrl || unknown.url, jobMarkdown: formatOriginalJobListingMarkdown(unknown, { audience: 'bundle' }) },
      });
      const dom = new JSDOM(html);
      try {
        const data = JSON.parse(dom.window.document.getElementById('ic-application-bundle-data').textContent);
        assert.equal(data.company, unknown.postedBy); assert.equal(data.jobUrl, unknown.applyUrl);
        assert.ok(data.jobMarkdown.includes('**Company:** Unknown company'));
        const link = dom.window.document.querySelector('.ic-job-posting-link');
        assert.equal(link.href, unknown.applyUrl); assert.equal(link.textContent, 'View original job posting');
        const panels = [...dom.window.document.querySelectorAll('[data-ic-document-panel]')];
        assert.ok(panels.length >= 2); assert.ok(panels.every(panel => !panel.textContent.includes(unknown.postedBy)));
        assert.ok(!dom.window.document.getElementById('ic-print-variant-note')?.getAttribute('data-ic-paper-context')?.includes(unknown.postedBy));
      } finally { dom.window.close(); }
    },
  },
  {
    name: 'Official posting bundle: paste, broken and working dock labels share the derived employer, poster and title fallbacks',
    run() {
      const handoff = { handoffCode: 'synthetic-code', prompt: 'Synthetic prompt', stage: 'resume' };
      const cases = [
        { data: { ...job, company: 'Scraped Poster', officialPosting: { ...job.officialPosting, title: 'Official Platform Engineer' } }, label: 'Northwind', title: 'Official Platform Engineer' },
        { data: { ...job, company: '', postedBy: 'Unknown Employer Poster', officialPosting: { level: 'L6', outcome: 'not-found', employer: '' } }, label: 'Unknown Employer Poster', title: job.title },
        { data: { title: 'Title fallback', company: '', postedBy: '' }, label: 'Title fallback', title: 'Title fallback' },
      ];
      for (const [index, entry] of cases.entries()) {
        const node = { id: `card-${index}`, data: { ...entry.data, localApplication: { id: `application-${index}`, status: 'queued' } } };
        const before = structuredClone(node);
        const requests = [applicationDockRequest({ node, handoff }), brokenApplicationDockRequest({ node, message: 'Synthetic repair required' }),
          workingApplicationDockRequest({ node, status: 'importing' })];
        assert.ok(requests.every(request => request.label === entry.label));
        assert.ok(requests.every(request => request.subject.includes(entry.title)));
        assert.deepEqual(node, before);
      }
    },
  },
  {
    name: 'Official posting bundle: interview reader still derives employer identity from the legacy header rather than poster provenance',
    async run() {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'official-bundle-interview-'));
      try {
        for (const [name, input] of [['known', job], ['unknown', { ...job, company: '', officialPosting: { ...job.officialPosting, level: 'L6', employer: '' } }]]) {
          const directory = path.join(root, name); await fs.mkdir(directory);
          await fs.writeFile(path.join(directory, 'Application.html'), '<html><body><main>Synthetic application copy.</main></body></html>');
          await fs.writeFile(path.join(directory, 'Original Job Listing.md'), formatOriginalJobListingMarkdown(input, { audience: 'bundle' }));
          const artifact = await captureInterviewPreparationBundle({ directory, userDataPath: root });
          assert.equal(artifact.job.title, input.title); assert.equal(artifact.job.company, input.company);
          assert.equal(artifact.job.location, input.location); assert.equal(artifact.verification.status, 'legacy-unverified');
        }
      } finally { await fs.rm(root, { recursive: true, force: true }); }
    },
  },
];
