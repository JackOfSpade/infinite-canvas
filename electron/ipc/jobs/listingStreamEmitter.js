/**
 * One Job Search run's writer for its saved listing stream.
 *
 * The Search side hands each results page here as soon as the page is saved.
 * Only the rules that belong to collecting are applied before a listing is
 * written, one row at a time, so nothing waits for the rest of the scrape:
 *
 *   - a listing that names a different country than the search is left out;
 *   - a listing posted before the search's date window is left out;
 *   - a listing this run already sent (same platform, same identity) is not
 *     sent twice;
 *   - a platform that has reached its listing limit sends no more.
 *
 * Everything that judges a listing (already seen or applied, role fit,
 * preferences, score, official posting, pay) belongs to the reader.
 */
import { filterProvablyOutsideCountryScope } from '../../../src/utils/jobLocation.js';
import { filterJobsByPostedSince } from '../jobDateFilter.js';
import crypto from 'node:crypto';
import { appendJobListingStreamRecords, jobListingStreamKeyFor } from '../jobListingStream.js';

/** Status codes the Search side writes. Fixed, so a reader can show them as text it owns. */
export const LISTING_STREAM_STATUS_CODES = Object.freeze([
  'run-started', 'source-progress', 'source-finished', 'source-stopped', 'run-gathered', 'run-paused', 'run-finished', 'run-failed',
]);

// What a listing said when it was last written, so a row that comes round
// again unchanged is not written twice and a changed one becomes an update.
function contentMark(job) {
  return crypto.createHash('sha1').update(JSON.stringify(job)).digest('hex');
}

function boundedText(value, max = 200) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

/**
 * @param {object}   options
 * @param {string}   options.root              stream root folder; null turns the writer off (no saved place to write)
 * @param {string}   options.streamId          the Job Search module's id
 * @param {string}   options.runId
 * @param {string}   [options.label]           the module's name, for the reader
 * @param {*}        [options.location]        the search location (country backstop)
 * @param {function} [options.postedSinceFor]  sourceId → inclusive start timestamp of that platform's date window
 * @param {number}   [options.jobsPerPlatform] listing limit per platform; none when not a positive number
 * @param {function} [options.now]
 * @param {function} [options.append]          test seam; defaults to the durable stream append
 */
export function createListingStreamEmitter({
  root, streamId, runId, label = '', location = null, postedSinceFor = null, jobsPerPlatform = null,
  now = () => Date.now(), append = appendJobListingStreamRecords,
} = {}) {
  const enabled = typeof root === 'string' && !!root && typeof streamId === 'string' && !!streamId;
  const limit = Number.isFinite(Number(jobsPerPlatform)) && Number(jobsPerPlatform) > 0 ? Math.floor(Number(jobsPerPlatform)) : Infinity;
  const sentKeysBySource = new Map();
  const counts = { listings: 0, updates: 0, outsideCountry: 0, beforeWindow: 0, repeated: 0, overLimit: 0, unreadable: 0 };

  const write = async (records) => {
    if (!enabled || records.length === 0) return { appended: 0, skipped: 0 };
    return append(root, streamId, records, { now: now(), label });
  };
  const sentFor = (sourceId) => {
    let sent = sentKeysBySource.get(sourceId);
    if (!sent) { sent = new Map(); sentKeysBySource.set(sourceId, sent); }
    return sent;
  };

  return {
    enabled,
    counts: () => ({ ...counts }),

    /** The run's inputs, so a reader can judge each listing by the search that found it. */
    async runStarted(run = {}) {
      await write([{ type: 'status', code: 'run-started', runId, run }]);
    },

    /**
     * One saved results page. Returns the listings written.
     * `seedOnly` records rows as already sent without writing them (a resumed
     * run's earlier pages were written by the attempt that read them).
     */
    async page({ sourceId, query = '', queryIndex = null, queryTotal = null, page = null, jobs = [], seedOnly = false } = {}) {
      const rows = (Array.isArray(jobs) ? jobs : []).filter(job => job && typeof job === 'object');
      if (rows.length === 0) return [];
      const inCountry = filterProvablyOutsideCountryScope(rows, location).jobs;
      counts.outsideCountry += rows.length - inCountry.length;
      const since = typeof postedSinceFor === 'function' ? postedSinceFor(sourceId) : null;
      const inWindow = filterJobsByPostedSince(inCountry, since, new Date(now()));
      counts.beforeWindow += inCountry.length - inWindow.length;
      const sent = sentFor(sourceId);
      const records = [];
      for (const job of inWindow) {
        const key = jobListingStreamKeyFor(job);
        if (!key) { counts.unreadable += 1; continue; }
        const mark = contentMark(job);
        if (sent.has(key)) {
          // The same listing read again. Unchanged: nothing to say. Changed (a
          // description that was owed has arrived): the reader gets an update.
          if (sent.get(key) === mark || seedOnly) { counts.repeated += 1; continue; }
          sent.set(key, mark);
          records.push({ type: 'update', key, runId, sourceId, job });
          continue;
        }
        if (sent.size >= limit) { counts.overLimit += 1; continue; }
        sent.set(key, mark);
        if (seedOnly) continue;
        records.push({ type: 'listing', key, runId, sourceId, query: boundedText(query), queryIndex, page, job });
      }
      if (seedOnly) return [];
      if (records.length > 0 || Number.isSafeInteger(queryIndex)) {
        const progress = {
          type: 'status', code: 'source-progress', runId, sourceId,
          queryIndex: Number.isSafeInteger(queryIndex) ? queryIndex : null,
          queryTotal: Number.isSafeInteger(queryTotal) ? queryTotal : null,
          page: Number.isSafeInteger(page) ? page : null,
          sent: sent.size,
        };
        await write([...records, progress]);
      }
      const listings = records.filter(record => record.type === 'listing');
      counts.listings += listings.length;
      counts.updates += records.length - listings.length;
      return listings.map(record => record.job);
    },

    /**
     * Listings this run already sent that now have more known about them
     * (a description fetched after the page was read). Rows never sent are
     * ignored: an update only ever describes a listing the reader has.
     */
    async update(jobs = []) {
      const records = [];
      for (const job of Array.isArray(jobs) ? jobs : []) {
        const key = jobListingStreamKeyFor(job);
        const sourceId = typeof job?.source === 'string' ? job.source : null;
        const sent = sourceId ? sentKeysBySource.get(sourceId) : null;
        if (!key || !sent?.has(key)) continue;
        const mark = contentMark(job);
        if (sent.get(key) === mark) continue; // nothing new to say
        sent.set(key, mark);
        records.push({ type: 'update', key, runId, sourceId, job });
      }
      await write(records);
      counts.updates += records.length;
      return records.length;
    },

    /** What the Search side is doing, for the reader to show. Never a command. */
    async status(code, detail = {}) {
      if (!LISTING_STREAM_STATUS_CODES.includes(code)) return;
      const { type: _type, code: _code, ...rest } = detail && typeof detail === 'object' ? detail : {};
      await write([{ type: 'status', code, runId, ...rest }]);
    },
  };
}
