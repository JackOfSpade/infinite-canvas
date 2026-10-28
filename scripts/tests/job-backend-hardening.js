import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';
import { GLASSDOOR_EXTRACTOR } from '../../electron/extractors/jobs.js';
import { walkJsonLdJobPostings } from '../../electron/extractors/jobPostingJsonLd.js';
import { appendJobsHistory, historyPathForCanvas, loadJobsHistory } from '../../electron/ipc/jobsHistory.js';
import { readJobAnalysisRecoveryLifecycle, recordJobAnalysisRecoveryLifecycle } from '../../electron/ipc/jobAnalysisRecoveryLifecycle.js';
import { filterJobsByAge, filterJobsByPostedSince, parsePostedDate } from '../../electron/ipc/jobDateFilter.js';
import { makeJobPageStop } from '../../electron/ipc/jobPageStop.js';

function extractGlassdoor(html) {
  const dom = new JSDOM(html, { url: 'https://www.glassdoor.ca/Job/search.htm', runScripts: 'outside-only' });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', {
    get() { return this.textContent || ''; },
  });
  try { return Array.from(dom.window.eval(GLASSDOOR_EXTRACTOR)); }
  finally { dom.window.close(); }
}

export default [
  {
    name: 'Browser paging and age filtering both retain the entire inclusive calendar boundary day',
    run() {
      const now = new Date(2026, 9, 28, 12);
      const boundaryRows = Array.from({ length: 3 }, (_, index) => ({ title: `Boundary Engineer ${index}`, posted: '2026-10-07' }));
      assert.equal(filterJobsByAge(boundaryRows, 21, now).length, 3);
      const stop = makeJobPageStop({ maxAgeDays: 21, now: () => now });
      for (let pageIndex = 0; pageIndex < 3; pageIndex += 1) {
        assert.equal(stop({ items: boundaryRows, pageIndex }).stop, false, 'in-window boundary rows cannot stop paging');
      }
      const oldRows = boundaryRows.map(job => ({ ...job, posted: '2026-10-06' }));
      assert.equal(stop({ items: oldRows, pageIndex: 3 }).stop, false);
      assert.equal(stop({ items: oldRows, pageIndex: 4 }).reason, 'age-window');
      assert.equal(filterJobsByAge([{ posted: '2026-10-07T01:00:00' }], 21, now).length, 0,
        'an actual timestamp keeps its exact cutoff');
    },
  },
  {
    name: 'Impossible relative posting dates stay unknown and cannot drop jobs or stop a browser walk',
    run() {
      const now = new Date(2026, 9, 28, 12);
      const labels = ['999999999999999999999999999999 days ago', '9007199254740991 weeks ago'];
      for (const posted of labels) {
        assert.equal(parsePostedDate(posted, now), null);
        const rows = Array.from({ length: 3 }, () => ({ posted }));
        assert.equal(filterJobsByAge(rows, 21, now).length, rows.length);
        assert.equal(filterJobsByPostedSince(rows, now.getTime(), now).length, rows.length);
        const stop = makeJobPageStop({ maxAgeDays: 21, now: () => now });
        assert.equal(stop({ items: rows }).stop, false);
        assert.equal(stop({ items: rows }).stop, false);
      }
    },
  },
  {
    name: 'Glassdoor resolves absolute protocol-relative and relative Apollo links without corrupting regional URLs',
    run() {
      const entries = [
        ['https://www.glassdoor.com/job-listing/absolute.htm?jl=17', 'https://www.glassdoor.com/job-listing/absolute.htm?jl=17'],
        ['//www.glassdoor.ca/job-listing/protocol.htm?jl=18', 'https://www.glassdoor.ca/job-listing/protocol.htm?jl=18'],
        ['/job-listing/root.htm?jl=19', 'https://www.glassdoor.ca/job-listing/root.htm?jl=19'],
        ['job-listing/relative.htm?jl=20', 'https://www.glassdoor.ca/job-listing/relative.htm?jl=20'],
      ];
      const apolloCache = Object.fromEntries(entries.map(([seoJobLink], index) => [
        `JobListing:${index}`, { jobTitleText: `Example Engineer ${index}`, seoJobLink },
      ]));
      apolloCache['JobListing:fallback'] = {
        jobTitleText: 'Fallback Engineer', seoJobLink: 'javascript:void(0)', jobLink: '/job-listing/fallback.htm?jl=21',
      };
      const jobs = extractGlassdoor(`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { apolloCache } } })}</script>`);
      assert.deepEqual(jobs.map(job => job.url), [...entries.map(([, expected]) => expected), 'https://www.glassdoor.ca/job-listing/fallback.htm?jl=21']);
    },
  },
  {
    name: 'Glassdoor DOM links use the same regional URL resolver and reject non-web schemes',
    run() {
      const jobs = extractGlassdoor(`<ul>
        <li data-jobid="17"><a data-test="jobTitle" href="//www.glassdoor.com/job-listing/example.htm?jl=17">Example Engineer</a></li>
        <li data-jobid="18"><a data-test="jobTitle" href="job-listing/relative.htm?jl=18">Relative Engineer</a></li>
        <li data-jobid="19"><a data-test="jobTitle" href="javascript:void(0)">Invalid Link Engineer</a></li>
      </ul>`);
      assert.deepEqual(jobs.map(job => job.url), [
        'https://www.glassdoor.com/job-listing/example.htm?jl=17',
        'https://www.glassdoor.ca/job-listing/relative.htm?jl=18', '',
      ]);
    },
  },
  {
    name: 'JSON-LD traversal ignores commented and script-embedded postings while preserving live blocks and visitor order',
    run() {
      const posting = title => JSON.stringify({ '@type': 'JobPosting', title });
      const html = `<!-- <script type="application/ld+json">${posting('Commented role')}</script> -->
        <script>const cached = '<script type="application/ld+json">${posting('Cached template role')}';</script>
        <script type="application/ld+json">${posting('Live role')}</script>
        <script type="application/ld+json; charset=utf-8">${posting('Second live role')}</script>`;
      assert.deepEqual(walkJsonLdJobPostings(html).map(job => job.title), ['Live role', 'Second live role']);
      const visited = [];
      const result = walkJsonLdJobPostings(html, job => {
        visited.push(job.title);
        if (job.title === 'Second live role') return job.title;
      });
      assert.equal(result, 'Second live role');
      assert.deepEqual(visited, ['Live role', 'Second live role']);
    },
  },
  {
    name: 'JSON-LD HTML contexts preserve live postings after attribute and raw-text comment markers',
    run() {
      const posting = title => `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title })}</script>`;
      const live = posting('Live role');
      const prefixes = [
        '<div data-template="<!--"></div>',
        "<div data-template='<!--'></div>",
        `<div data-template='${posting('Attribute role')}'></div>`,
        '<textarea><!--</textarea>',
        `<textarea>${posting('Textarea role')}</textarea>`,
        '<style><!--</style>',
        `<style>${posting('Style role')}</style>`,
        `<iframe>${posting('Iframe role')}</iframe>`,
        `<xmp>${posting('Example role')}</xmp>`,
        `<template>${posting('Inert template role')}</template>`,
        `<noscript>${posting('Disabled scripting role')}</noscript>`,
      ];
      for (const prefix of prefixes) {
        const html = `${prefix}${live}`;
        const dom = new JSDOM(html, { runScripts: 'dangerously', virtualConsole: new VirtualConsole() });
        try {
          assert.equal(dom.window.document.querySelectorAll('script[type="application/ld+json"]').length, 1);
          assert.deepEqual(walkJsonLdJobPostings(html).map(job => job.title), ['Live role'], prefix);
        } finally { dom.window.close(); }
      }
    },
  },
  {
    name: 'History append preserves existing rows after a transient read error and the next append can recover',
    async run() {
      const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-history-read-'));
      const canvasPath = path.join(directory, 'canvas.json');
      const historyPath = historyPathForCanvas(canvasPath);
      const first = { source: 'example', title: 'First Engineer', company: 'Example', location: 'Toronto', url: 'https://jobs.example/first' };
      const second = { ...first, title: 'Second Engineer', url: 'https://jobs.example/second' };
      const originalReadFile = fs.promises.readFile;
      try {
        assert.equal((await appendJobsHistory(canvasPath, [first])).written, 1);
        const baseline = await originalReadFile(historyPath, 'utf8');
        fs.promises.readFile = async function (filePath, ...args) {
          if (filePath === historyPath) throw Object.assign(new Error('Synthetic transient read failure'), { code: 'EIO' });
          return originalReadFile.call(this, filePath, ...args);
        };
        const failed = await appendJobsHistory(canvasPath, [second]);
        assert.equal(failed.written, 0);
        assert.match(failed.error, /Synthetic transient read failure/);
        assert.equal(await originalReadFile(historyPath, 'utf8'), baseline);
        assert.deepEqual(await loadJobsHistory(canvasPath), [], 'search reads still fail open');
        fs.promises.readFile = originalReadFile;
        assert.equal((await appendJobsHistory(canvasPath, [second])).written, 1);
        assert.deepEqual((await loadJobsHistory(canvasPath)).map(job => job.title), [first.title, second.title]);
      } finally {
        fs.promises.readFile = originalReadFile;
        await fs.promises.rm(directory, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'Recovery lifecycle skips malformed journal events and preserves valid receipts during concurrent writes',
    async run() {
      const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-lifecycle-malformed-'));
      const journalPath = path.join(directory, 'lifecycle.json');
      try {
        await fs.promises.writeFile(journalPath, JSON.stringify({ schemaVersion: 1, events: [
          null, [], 17, { at: 1, operation: 'snapshot-save', result: 'saved' },
        ] }));
        assert.equal(readJobAnalysisRecoveryLifecycle(journalPath).retained, 1);
        for (const invalid of [null, [], 17, undefined]) {
          assert.equal(await recordJobAnalysisRecoveryLifecycle(journalPath, invalid), false);
        }
        const results = await Promise.all([2, 3, 4].map(at => recordJobAnalysisRecoveryLifecycle(journalPath, {
          at, operation: 'snapshot-save', result: 'saved', reason: 'normal-save',
        })));
        assert.deepEqual(results, [true, true, true]);
        const snapshot = readJobAnalysisRecoveryLifecycle(journalPath);
        assert.equal(snapshot.retained, 4);
        assert.deepEqual(snapshot.events.map(event => event.at), [4, 3, 2, 1]);
      } finally {
        await fs.promises.rm(directory, { recursive: true, force: true });
      }
    },
  },
];
