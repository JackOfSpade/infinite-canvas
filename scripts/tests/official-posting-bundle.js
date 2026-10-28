import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import { formatOriginalJobListingMarkdown, ORIGINAL_JOB_LISTING_BODY_HEADING } from '../../electron/ipc/applicationBundle.js';
import { buildResumeDocument, normaliseResumeDownloadBundle } from '../../electron/ipc/resumeHtml.js';
import { normalizeOfficialPosting, officialPostingLookupStatus } from '../../electron/ipc/officialPostingFields.js';
import { officialPostingDisplay } from '../../src/utils/officialPostingDisplay.js';
import { captureInterviewPreparationBundle } from '../../electron/ipc/interviewPreparation.js';
import { applicationDockRequest, brokenApplicationDockRequest, workingApplicationDockRequest } from '../../src/utils/applicationHandoffDock.js';

const job = {
  title: 'Platform Engineer', company: 'Northwind', location: 'Toronto, Ontario, Canada', salary: 'C$140,000 per year',
  url: 'https://board.example.test/jobs/one', snippet: 'Own reliable systems and maintain the platform.',
  postedBy: 'Recruiter * Team', applyUrl: 'https://careers.northwind.example/jobs/one',
  officialPosting: { level: 'L3', outcome: 'found', employer: 'Northwind', sourceUrl: 'https://careers.northwind.example/jobs/one', officialApplyUrl: 'https://careers.northwind.example/jobs/one/application', trail: ['structured-proof'] },
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
      assert.ok(header.includes(`**Official posting:** <${job.officialPosting.sourceUrl}>`));
      assert.ok(header.includes('**Source level:** L3: Employer\'s ATS'));
      assert.ok(header.includes(`**Listing URL:** <${job.url}>`));
      assert.ok(body.includes(ORIGINAL_JOB_LISTING_BODY_HEADING)); assert.ok(body.includes(job.snippet));
      assert.ok(body.includes('## Posting locations') && body.includes('**Ottawa:** <https://board.example.test/jobs/two>'));
      const unsafe = formatOriginalJobListingMarkdown({ ...job, applyUrl: 'https://secret@careers.example.test/one', officialPosting: { level: '__proto__' } }, { audience: 'bundle' });
      assert.ok(!unsafe.includes('Apply URL') && !unsafe.includes('Source level') && !unsafe.includes('secret'));
      const absent = formatOriginalJobListingMarkdown({ title: 'Legacy role', snippet: 'Legacy body' }, { audience: 'bundle' });
      assert.ok(absent.includes('**Official posting check:** Official posting not checked'));
      assert.equal(absent.split('\n---\n')[1], formatOriginalJobListingMarkdown({ title: 'Legacy role', snippet: 'Legacy body' }).split('\n---\n')[1]);
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
      assert.ok(source.includes("jobUrl: input.job?.url || ''"));
      assert.ok(source.includes('officialPosting: downloadOfficialPosting'));
      assert.ok(source.includes("jobContext: { title: input.job?.title || '', company: input.job?.company || '', location: input.job?.location || '' }"));
    },
  },
  {
    name: 'Official posting bundle: download metadata may name the poster while documents retain the unknown employer and original fallback link',
    run() {
      const unknown = { ...job, company: '', postedBy: 'Unique Recruiting Poster', postingVariants: [], officialPosting: { ...job.officialPosting, level: 'L6', employer: '' } };
      const html = buildResumeDocument({
        resumeMainHtml: '<main class="page"><h1 class="name">Synthetic Candidate</h1><p>Candidate experience.</p></main>',
        docId: 'official-bundle-synthetic', coverLetter: { name: 'Synthetic Candidate', greeting: 'Dear Hiring Team,', paragraphs: ['I would welcome a discussion.'] },
        jobContext: { title: unknown.title, company: unknown.company, location: unknown.location },
        downloadBundle: { company: unknown.company || unknown.postedBy, candidateName: 'Synthetic Candidate',
          jobUrl: unknown.url, officialPosting: unknown.officialPosting, jobMarkdown: formatOriginalJobListingMarkdown(unknown, { audience: 'bundle' }) },
      });
      const dom = new JSDOM(html);
      try {
        const data = JSON.parse(dom.window.document.getElementById('ic-application-bundle-data').textContent);
        assert.equal(data.company, unknown.postedBy); assert.equal(data.jobUrl, unknown.url);
        assert.deepEqual(data.officialPosting, unknown.officialPosting);
        assert.ok(data.jobMarkdown.includes('**Company:** Unknown company'));
        const link = dom.window.document.querySelector('.ic-job-posting-link');
        assert.equal(link.href, unknown.url); assert.equal(link.textContent, 'View original job posting');
        const panels = [...dom.window.document.querySelectorAll('[data-ic-document-panel]')];
        assert.ok(panels.length >= 2); assert.ok(panels.every(panel => !panel.textContent.includes(unknown.postedBy)));
        assert.ok(!dom.window.document.getElementById('ic-print-variant-note')?.getAttribute('data-ic-paper-context')?.includes(unknown.postedBy));
      } finally { dom.window.close(); }
    },
  },
  {
    name: 'Official posting bundle: incomplete lookup reasons survive inert JSON and agree across cards, Markdown and HTML',
    run() {
      const cases = [
        ['bridge-unavailable', /research unavailable/u], ['bridge-timeout', /research timed out/u],
        ['fetch-timeout', /page fetch timed out/u], ['crawl-budget', /search coverage limited/u],
        ['fetch-failed', /page could not be fetched/u], ['semantic-uncertain', /match uncertain/u],
        ['comparative-invalid', /match uncertain/u], ['official-text-missing', /posting could not be read/u],
      ];
      for (const level of ['L5', 'L6']) for (const [code, reason] of cases) {
        const officialPosting = { level, outcome: 'not-found', employer: level === 'L6' ? '' : 'Northwind',
          sourceUrl: 'https://careers.northwind.example/unverified-candidate',
          trail: ['bridge-research', code], fetchedAt: '2026-10-01T12:00:00.000Z', scrapedListingSha256: 'b'.repeat(64) };
        const value = { ...job, officialPosting, postingVariants: [], applyUrl: '' };
        const status = officialPostingLookupStatus(officialPosting);
        assert.equal(status.state, 'incomplete'); assert.equal(status.retryable, true);
        assert.match(status.label, reason); assert.match(status.detail, /retry/iu);
        const markdown = formatOriginalJobListingMarkdown(value, { audience: 'bundle' });
        assert.ok(markdown.includes(`**Official posting check:** ${status.label}`));
        assert.ok(!markdown.includes('**Official posting:**') && !markdown.includes('No exact official posting found'));
        const card = officialPostingDisplay(value);
        assert.ok(card.statusLabel.includes(status.label)); assert.equal(card.statusDetail, status.detail);
        assert.equal(card.applyUrl, value.url);
        const dom = new JSDOM(buildResumeDocument({ resumeMainHtml: '<main class="page"><h1 class="name">Synthetic Candidate</h1><p>Unchanged document copy.</p></main>',
          downloadBundle: { jobUrl: value.url, officialPosting, jobMarkdown: markdown } }));
        try {
          const document = dom.window.document;
          const data = JSON.parse(document.getElementById('ic-application-bundle-data').textContent);
          assert.deepEqual(data.officialPosting, normalizeOfficialPosting(officialPosting));
          const notice = document.querySelector('[data-ic-official-posting-status="incomplete"]');
          assert.equal(notice.querySelector('strong').textContent, status.label);
          assert.equal(notice.querySelector('span').textContent, status.detail);
          assert.equal(document.querySelector('.ic-job-posting-link').href, value.url);
          assert.equal(document.querySelector('.ic-job-posting-link').textContent, 'View original job posting');
          assert.ok(!document.querySelector('[data-ic-document-panel]').textContent.includes(status.label));
        } finally { dom.window.close(); }
      }
    },
  },
  {
    name: 'Official posting bundle: completed no-match, ambiguity and closure stay distinct from interrupted research',
    run() {
      for (const [outcome, trail, state, label] of [
        ['not-found', ['bridge-research'], 'not-found', 'No exact official posting found'],
        ['ambiguous', ['comparative-disagree'], 'ambiguous', 'Several official postings match'],
        ['closed', ['closed'], 'closed', 'Official posting closed'],
      ]) {
        const officialPosting = { level: 'L5', outcome, employer: 'Northwind', trail };
        const status = officialPostingLookupStatus(officialPosting);
        assert.equal(status.state, state); assert.equal(status.label, label); assert.equal(status.retryable, false);
        assert.equal(officialPostingDisplay({ ...job, officialPosting }).statusLabel, label);
        assert.ok(formatOriginalJobListingMarkdown({ ...job, officialPosting }, { audience: 'bundle' }).includes(label));
        assert.deepEqual(normaliseResumeDownloadBundle({ officialPosting }).officialPosting, officialPosting);
      }
    },
  },
  {
    name: 'Official posting bundle: a failed recheck keeps the previous exact link while disclosing its current uncertainty',
    run() {
      const officialPosting = { ...job.officialPosting, trail: ['structured-proof', 'fetch-failed', 'reverify-failed'] };
      const status = officialPostingLookupStatus(officialPosting);
      assert.equal(status.state, 'verified'); assert.equal(status.retryable, true);
      assert.equal(status.sourceUrl, officialPosting.sourceUrl);
      assert.equal(status.label, 'Previously verified official posting');
      assert.match(status.detail, /page could not be fetched/u); assert.match(status.detail, /Retry/u);
      const markdown = formatOriginalJobListingMarkdown({ ...job, officialPosting }, { audience: 'bundle' });
      assert.ok(markdown.includes(status.label) && markdown.includes('Latest recheck'));
      const dom = new JSDOM(buildResumeDocument({ resumeMainHtml: '<main class="page"><h1 class="name">Synthetic Candidate</h1></main>',
        downloadBundle: { jobUrl: job.url, officialPosting } }));
      try {
        const document = dom.window.document;
        assert.equal(document.querySelector('[data-ic-official-posting-status] strong').textContent, status.label);
        assert.equal(document.querySelector('.ic-job-posting-link').href, officialPosting.sourceUrl);
        assert.ok([...document.querySelectorAll('.ic-job-posting-link')].some(link => link.href === job.url), 'original provenance remains visible');
      } finally { dom.window.close(); }
    },
  },
  {
    name: 'Official posting bundle: older verified link metadata migrates safely while modern failure metadata is retained without promoting links',
    run() {
      const legacy = { level: 'L2', sourceUrl: 'https://careers.northwind.example/jobs/one?utm_source=mirror',
        officialApplyUrl: 'https://careers.northwind.example/jobs/one/application' };
      const normalized = normaliseResumeDownloadBundle({ officialPosting: legacy }).officialPosting;
      assert.equal(officialPostingLookupStatus(normalized).state, 'verified');
      assert.equal(normalized.sourceUrl, 'https://careers.northwind.example/jobs/one');
      for (const failed of [
        { ...legacy, outcome: 'failed', employer: 'Northwind', trail: ['fetch-timeout'] },
        { ...legacy, level: 'L5', outcome: 'not-found', employer: 'Northwind', trail: ['bridge-unavailable'] },
      ]) {
        const saved = normaliseResumeDownloadBundle({ officialPosting: failed }).officialPosting;
        assert.deepEqual(saved, normalizeOfficialPosting(failed));
        assert.equal(officialPostingLookupStatus(saved).sourceUrl, '');
        assert.equal(officialPostingLookupStatus(saved).applyUrl, '');
      }
      for (const invalid of [
        { level: 'L2', sourceUrl: 'https://user:secret@careers.northwind.example/one' },
        { ...legacy, outcome: 'failed' }, { ...legacy, level: 'L5' }, { ...legacy, untrusted: 'extra' },
      ]) assert.equal(normaliseResumeDownloadBundle({ officialPosting: invalid }).officialPosting, undefined);
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
