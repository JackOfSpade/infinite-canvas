import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  JOB_LISTING_STREAM_RETENTION_MS,
  appendJobListingStreamRecords,
  jobListingStreamDay,
  jobListingStreamKey,
  jobListingStreamKeyFor,
  jobListingStreamStart,
  listJobListingStreams,
  normalizeJobListingStreamPosition,
  pruneJobListingStream,
  readJobListingStream,
  removeJobListingStream,
} from '../../electron/ipc/jobListingStream.js';
import { createListingStreamEmitter } from '../../electron/ipc/jobs/listingStreamEmitter.js';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 10, 23, 12, 0, 0);
const tempRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'job-listing-stream-test-'));
const job = (n, extra = {}) => ({
  title: `Engineer ${n}`, company: 'Example Co', location: 'Toronto, ON', source: 'indeed',
  url: `https://www.indeed.com/viewjob?jk=${String(n).padStart(16, '0')}`, snippet: '', ...extra,
});
const listing = (n, extra = {}) => ({ type: 'listing', runId: 'run-1', sourceId: 'indeed', query: 'Engineer', queryIndex: 0, page: 1, job: job(n), ...extra });

export default [
  {
    name: 'listing stream: appended listings are read back in order from a saved position, and a re-read is harmless',
    async run() {
      const root = tempRoot();
      try {
        const first = await appendJobListingStreamRecords(root, 'search-1', [listing(1), listing(2)], { now: T0, label: 'Product roles' });
        assert.deepEqual(first, { appended: 2, skipped: 0 });
        let read = await readJobListingStream(root, 'search-1', jobListingStreamStart());
        assert.deepEqual(read.records.map(r => r.job.title), ['Engineer 1', 'Engineer 2']);
        assert.equal(read.atEnd, true);
        assert.equal(read.records[0].key, jobListingStreamKeyFor(job(1)), 'a listing carries its stable identity');
        assert.equal(read.records[0].at, T0);
        assert.equal(read.records[0].v, 1);
        // The reader saves the position after the last record it finished.
        const afterFirst = read.records[0].next;
        const afterAll = read.position;
        assert.deepEqual(read.records[1].next, afterAll);
        // Nothing new: the same position reads nothing.
        read = await readJobListingStream(root, 'search-1', afterAll);
        assert.deepEqual(read.records, []);
        assert.deepEqual(read.position, afterAll);
        // A reader that was interrupted after the first job redoes only the second.
        read = await readJobListingStream(root, 'search-1', afterFirst);
        assert.deepEqual(read.records.map(r => r.job.title), ['Engineer 2']);
        // Later appends are read from the saved position.
        await appendJobListingStreamRecords(root, 'search-1', [listing(3)], { now: T0 + 1000 });
        read = await readJobListingStream(root, 'search-1', afterAll);
        assert.deepEqual(read.records.map(r => r.job.title), ['Engineer 3']);
        // Another reader keeps its own position.
        read = await readJobListingStream(root, 'search-1', jobListingStreamStart());
        assert.equal(read.records.length, 3);
        assert.deepEqual(await listJobListingStreams(root), [{ streamId: 'search-1', label: 'Product roles', createdAt: T0 }]);
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    },
  },
  {
    name: 'listing stream: updates and status records pass through; malformed records are never written',
    async run() {
      const root = tempRoot();
      try {
        const result = await appendJobListingStreamRecords(root, 'search-1', [
          listing(1),
          { type: 'update', runId: 'run-1', sourceId: 'indeed', job: job(1, { snippet: 'Full description.' }) },
          { type: 'status', code: 'source-progress', runId: 'run-1', sourceId: 'glassdoor', queryIndex: 2, queryTotal: 10 },
          { type: 'status' },
          { type: 'listing', job: null },
          { type: 'command', code: 'start-scrape' },
          { type: 'listing', job: { title: '', company: '' } },
        ], { now: T0 });
        assert.deepEqual(result, { appended: 3, skipped: 4 });
        const read = await readJobListingStream(root, 'search-1', null);
        assert.deepEqual(read.records.map(r => r.type), ['listing', 'update', 'status']);
        assert.equal(read.records[1].key, read.records[0].key, 'an update names the listing it belongs to');
        assert.equal(read.records[1].job.snippet, 'Full description.');
        assert.equal(read.records[2].code, 'source-progress');
        assert.equal(read.records[2].queryTotal, 10);
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    },
  },
  {
    name: 'listing stream: a line still being written is left for the next read; a line torn by a crash is passed over',
    async run() {
      const root = tempRoot();
      try {
        await appendJobListingStreamRecords(root, 'search-1', [listing(1)], { now: T0 });
        const file = path.join(root, jobListingStreamKey('search-1'), `${jobListingStreamDay(T0)}.jsonl`);
        fs.appendFileSync(file, '{"v":1,"type":"listing","at":1,"key":"k","job":{"title":"Half');
        let read = await readJobListingStream(root, 'search-1', null);
        assert.deepEqual(read.records.map(r => r.job.title), ['Engineer 1']);
        const held = read.position;
        // The same day: the writer starts a fresh line, the torn one fails to parse and is skipped.
        await appendJobListingStreamRecords(root, 'search-1', [listing(2)], { now: T0 + 1000 });
        read = await readJobListingStream(root, 'search-1', held);
        assert.deepEqual(read.records.map(r => r.job.title), ['Engineer 2']);
        // A torn last line in an older day file must not hold the reader there for ever.
        fs.appendFileSync(file, '{"v":1,"type":"listing","torn');
        await appendJobListingStreamRecords(root, 'search-1', [listing(3)], { now: T0 + DAY });
        read = await readJobListingStream(root, 'search-1', read.position);
        assert.deepEqual(read.records.map(r => r.job.title), ['Engineer 3']);
        assert.equal(read.position.day, jobListingStreamDay(T0 + DAY));
        assert.equal(read.atEnd, true);
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    },
  },
  {
    name: 'listing stream: a long backlog is read in steps; old days are removed by age and a reader carries on from what is left',
    async run() {
      const root = tempRoot();
      try {
        await appendJobListingStreamRecords(root, 'search-1', [listing(1), listing(2), listing(3)], { now: T0 });
        await appendJobListingStreamRecords(root, 'search-1', [listing(4), listing(5)], { now: T0 + DAY });
        let read = await readJobListingStream(root, 'search-1', null, { limit: 2 });
        assert.deepEqual(read.records.map(r => r.job.title), ['Engineer 1', 'Engineer 2']);
        assert.equal(read.atEnd, false);
        read = await readJobListingStream(root, 'search-1', read.position, { limit: 2 });
        assert.deepEqual(read.records.map(r => r.job.title), ['Engineer 3', 'Engineer 4']);
        assert.equal(read.atEnd, false);
        const middle = read.position;
        read = await readJobListingStream(root, 'search-1', middle, { limit: 2 });
        assert.deepEqual(read.records.map(r => r.job.title), ['Engineer 5']);
        assert.equal(read.atEnd, true);
        // Retention is by age, whatever any reader has confirmed.
        assert.equal(await pruneJobListingStream(root, 'search-1', { now: T0 + DAY }), 0, 'nothing is old enough yet');
        const later = T0 + DAY + JOB_LISTING_STREAM_RETENTION_MS;
        assert.equal(await pruneJobListingStream(root, 'search-1', { now: later }), 1, 'the first day is past the retention age');
        read = await readJobListingStream(root, 'search-1', null);
        assert.deepEqual(read.records.map(r => r.job.title), ['Engineer 4', 'Engineer 5'], 'a new reader starts from what is kept');
        read = await readJobListingStream(root, 'search-1', { day: jobListingStreamDay(T0), offset: 5 });
        assert.deepEqual(read.records.map(r => r.job.title), ['Engineer 4', 'Engineer 5'], 'a reader whose file was removed continues from the oldest left');
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    },
  },
  {
    name: 'listing stream: ids are confined to the root, streams are separate, and a removed stream is gone',
    async run() {
      const root = tempRoot();
      try {
        const odd = '../../etc/passwd\u0000 weird id';
        await appendJobListingStreamRecords(root, odd, [listing(1)], { now: T0 });
        await appendJobListingStreamRecords(root, 'search-2', [listing(9)], { now: T0 + 5 });
        assert.deepEqual(fs.readdirSync(root).sort(), [jobListingStreamKey(odd), jobListingStreamKey('search-2')].sort());
        assert.match(jobListingStreamKey(odd), /^[a-f0-9]{32}$/u);
        assert.deepEqual((await readJobListingStream(root, odd, null)).records.map(r => r.job.title), ['Engineer 1']);
        assert.deepEqual((await readJobListingStream(root, 'search-2', null)).records.map(r => r.job.title), ['Engineer 9']);
        assert.deepEqual((await readJobListingStream(root, 'never-written', null)).records, []);
        assert.equal((await listJobListingStreams(root)).length, 2);
        assert.equal(await removeJobListingStream(root, odd), true);
        assert.deepEqual((await listJobListingStreams(root)).map(s => s.streamId), ['search-2']);
        await assert.rejects(() => appendJobListingStreamRecords('relative/root', 'search-1', [listing(1)], { now: T0 }));
        await assert.rejects(() => appendJobListingStreamRecords(root, 'search-1', [listing(1)], {}), /timestamp/u);
        assert.deepEqual(normalizeJobListingStreamPosition({ day: 'nope', offset: -4 }), { day: null, offset: 0 });
        assert.deepEqual(normalizeJobListingStreamPosition({ day: '2026-11-23', offset: 12 }), { day: '2026-11-23', offset: 12 });
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    },
  },
  {
    name: 'search emitter: each page is written at once, with only the collecting rules applied',
    async run() {
      const root = tempRoot();
      try {
        const windowStart = T0 - 7 * DAY;
        const us = (n, extra = {}) => job(n, { location: 'Austin, TX', ...extra });
        const emitter = createListingStreamEmitter({
          root, streamId: 'search-1', runId: 'run-1', label: 'Product roles', location: 'United States',
          postedSinceFor: () => windowStart, jobsPerPlatform: 3, now: () => T0,
        });
        assert.equal(emitter.enabled, true);
        await emitter.runStarted({ queries: ['Engineer'], canonicalLocation: 'United States', careerSnapshotId: 'c'.repeat(64) });
        const sent = await emitter.page({
          sourceId: 'indeed', query: 'Engineer', queryIndex: 0, queryTotal: 10, page: 1,
          jobs: [
            us(1, { posted: '2 days ago' }),
            us(2, { posted: '30 days ago' }),
            job(3, { location: 'Toronto, ON, Canada' }),
            us(1, { posted: '2 days ago' }),
            us(4),
            us(5),
            us(6),
          ],
        });
        assert.deepEqual(sent.map(j => j.title), ['Engineer 1', 'Engineer 4', 'Engineer 5']);
        assert.deepEqual(emitter.counts(), { listings: 3, updates: 0, outsideCountry: 1, beforeWindow: 1, repeated: 1, overLimit: 1, unreadable: 0 });
        // Another platform has its own limit and its own identities.
        await emitter.page({ sourceId: 'glassdoor', queryIndex: 0, page: 1, jobs: [us(7, { source: 'glassdoor', url: 'https://www.glassdoor.com/job-listing/a.htm?jl=7' })] });
        // A description that arrives later is an update to a listing already sent; an unsent row is ignored.
        assert.equal(await emitter.update([us(4, { snippet: 'Now with the full text.' }), us(2, { snippet: 'never sent' })]), 1);
        assert.equal(await emitter.update([us(4, { snippet: 'Now with the full text.' })]), 0, 'an unchanged listing is not sent again');
        // A page that brings an owed description for a listing already sent becomes an update, not a second listing.
        assert.deepEqual(await emitter.page({ sourceId: 'indeed', queryIndex: 0, page: 2, jobs: [us(5, { snippet: 'Owed text, now read.' }), us(1, { posted: '2 days ago' })] }), []);
        await emitter.status('source-stopped', { sourceId: 'indeed', reason: 'check' });
        await emitter.status('start-scrape', { sourceId: 'indeed' });
        const read = await readJobListingStream(root, 'search-1', null);
        assert.deepEqual(read.records.map(r => (r.type === 'status' ? r.code : `${r.type}:${r.job.title}`)), [
          'run-started', 'listing:Engineer 1', 'listing:Engineer 4', 'listing:Engineer 5', 'source-progress',
          'listing:Engineer 7', 'source-progress', 'update:Engineer 4', 'update:Engineer 5', 'source-progress', 'source-stopped',
        ]);
        assert.equal(read.records[0].run.canonicalLocation, 'United States');
        assert.deepEqual({ q: read.records[4].queryIndex, total: read.records[4].queryTotal, page: read.records[4].page, sent: read.records[4].sent },
          { q: 0, total: 10, page: 1, sent: 3 });
        assert.equal(read.records[7].job.snippet, 'Now with the full text.');
        assert.ok(read.records.every(r => r.runId === 'run-1'));
        // A resumed run marks its earlier pages as sent without writing them again.
        const resumed = createListingStreamEmitter({ root, streamId: 'search-1', runId: 'run-1', location: 'United States', now: () => T0 + 1 });
        assert.deepEqual(await resumed.page({ sourceId: 'indeed', jobs: [us(1), us(4)], seedOnly: true }), []);
        assert.deepEqual((await resumed.page({ sourceId: 'indeed', queryIndex: 0, page: 2, jobs: [us(4), us(8)] })).map(j => j.title), ['Engineer 8']);
        // No saved place to write: the writer is off and never throws.
        const off = createListingStreamEmitter({ root: null, streamId: 'search-1', runId: 'run-1' });
        assert.equal(off.enabled, false);
        assert.deepEqual((await off.page({ sourceId: 'indeed', jobs: [us(9)] })).map(j => j.title), ['Engineer 9']);
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    },
  },
  {
    name: 'listing stream: appends made at the same time all land as whole lines',
    async run() {
      const root = tempRoot();
      try {
        await Promise.all(Array.from({ length: 20 }, (_, n) => appendJobListingStreamRecords(root, 'search-1', [listing(n + 1), listing(n + 101)], { now: T0 + n })));
        const read = await readJobListingStream(root, 'search-1', null);
        assert.equal(read.records.length, 40);
        assert.equal(new Set(read.records.map(r => r.key)).size, 40);
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    },
  },
];
