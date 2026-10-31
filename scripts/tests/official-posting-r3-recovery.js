import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createOfficialPostingRecoveryPassResolver, officialPostingDedup, resolveOfficialPostings } from '../../electron/ipc/officialPostingService.js';
import { unresolvedOfficialPosting } from '../../electron/ipc/officialPostingResolver.js';
import { scoreSafeRowsWithBoardClosed } from '../../electron/ipc/officialPostingBoardClosed.js';
import { filterNonEnglishJobs } from '../../src/utils/jobLanguage.js';

const description = 'Requirements include building reliable dispatch services and documenting route reports with the operations team.';
const job = (id, extra = {}) => ({ source: 'google', title: 'Dispatch Engineer', company: 'Northwind Labs', location: 'Lakeview, Ontario, Canada',
  snippet: description, url: `https://mirror.test/jobs/${id}`, ...extra });
const metadata = (extra = {}) => ({ level: 'L1', outcome: 'found', employer: 'Northwind Labs', title: 'Dispatch Engineer',
  sourceUrl: 'https://northwind.test/jobs/dispatch', officialApplyUrl: 'https://northwind.test/jobs/dispatch', trail: [], ...extra });
const response = prompt => prompt.match(/Requested ids: ([a-f0-9, ]+)\./u)[1].split(', ').map(id =>
  `BEGIN OFFICIAL POSTING RESEARCH ${id}\nNOT FOUND\nEND OFFICIAL POSTING RESEARCH ${id}`).join('\n');
function result(rows, telemetry = null) {
  const dedup = officialPostingDedup(rows);
  return { jobs: dedup.kept, officialPosting: telemetry, officialDedupDropped: dedup.dropped.length, officialDedupDrops: dedup.dropped };
}
function actualGenericGlue(resolveRows, row, checkpoints) {
  const source = fs.readFileSync(new URL('../../electron/ipc/jobs.js', import.meta.url), 'utf8');
  const generic = source.indexOf('const runGenericResolve = async () =>');
  const init = source.indexOf('const resolveGenericPostings =', generic);
  const persist = source.indexOf('const persistSourceRecoveryJobs = async', generic);
  const publish = source.indexOf('const officialResolution = await resolveGenericPostings(', generic);
  const languageFilter = source.indexOf('const languageFilter = filterNonEnglishJobs(items);', publish);
  assert.ok(init > generic && persist > init && publish > persist, 'generic handler owns one pass receipt across checkpoint and publication');
  assert.ok(languageFilter > publish, 'generic publication resolves official postings before filtering listing languages');
  const context = {
    createOfficialPostingRecoveryPassResolver, resolveScoreSafePostings: resolveRows,
    sourceRecoverySnapshot: { jobs: [], descriptionRecoveryJobs: [row], profile: {}, careerData: '', careerSnapshotId: 'synthetic-career', nodeId: 'board' },
    sourceRecoveryJobs: [row], sourceRecoveryCheckpointOwned: true, recoveryCheckpointOutcome: 'unchanged', sourceId: 'google',
    snapshotDescriptionRecoveryJobs: snapshot => snapshot.descriptionRecoveryJobs,
    mergeDescriptionRecoverySourceJobs: (_previous, _source, rows) => rows,
    filterJobsByDescriptionEvidence: rows => ({ jobs: rows }), filterNonEnglishJobs, overlayResolvedRecoveryRows: rows => rows, scoreSafeRowsWithBoardClosed,
    buildJobAnalysisSnapshot: args => ({ snapshot: args }),
    saveDescriptionRecoverySnapshotIfCurrent: async snapshot => { await Promise.resolve(); checkpoints.push(snapshot); return { saved: true }; },
    requireDescriptionRecoveryCheckpointPersisted: receipt => { assert.equal(receipt.saved, true); return receipt; },
    event: { sender: {} }, nodeId: 'board', signal: new AbortController().signal, jobRunId: 'run', canvasFilePath: '/synthetic/canvas.json',
    continuationAdmission: { continuation: false }, operationAuthority: {}, logger: { warn() {}, info() {} },
  };
  vm.runInNewContext(`${source.slice(init, source.indexOf('// Load the recovery snapshot', init))}\n${source.slice(persist, source.indexOf('// The normal manual-scrape path', persist))}\nglobalThis.api = { persist: persistSourceRecoveryJobs, publish: async items => { const descriptionEvidence = { jobs: items }; ${source.slice(publish, languageFilter)} return officialResolution; } };`, context);
  return context.api;
}

export default [
  {
    name: 'R3 generic recovery checkpoints exclude non-English descriptions from score-ready jobs',
    async run() {
      const english = job('english', { description: 'Responsibilities include building reliable software and documenting system requirements with the operations team. '.repeat(8) });
      const french = job('french', { description: 'Nous recherchons une personne pour rejoindre notre équipe. Vous serez responsable de développer des applications et de travailler avec les équipes techniques. '.repeat(8) });
      const checkpoints = [];
      const glue = actualGenericGlue(async rows => result(rows), french, checkpoints);
      await glue.persist([english, french]);
      assert.equal(checkpoints.length, 1);
      assert.deepEqual(checkpoints[0].jobs.map(row => row.url), [english.url]);
      assert.equal(checkpoints[0].descriptionRecoveryJobs.length, 2, 'the recovery pool retains source evidence separately');
    },
  },
  {
    name: 'R3 generic Solve rejudges changed checkpoint input and resolves genuinely new rows once',
    async run() {
      const first = job('one'); const fresh = job('two'); const calls = []; const checkpoints = []; let handoffs = 0; let saves = 0;
      const resolveRows = async rows => {
        calls.push(rows.map(row => row.url));
        const resolved = await resolveOfficialPostings(rows, { store: { find: async () => null, save: async () => { saves++; throw new Error('transient results must not save'); } },
          fetch: () => { throw new Error('injected host resolver must not fetch'); },
          resolve: async row => unresolvedOfficialPosting(row, { trail: ['fetch-failed'] }),
          callRaw: async prompt => { handoffs++; return response(prompt); } });
        return result(resolved.jobs, resolved.telemetry);
      };
      const glue = actualGenericGlue(resolveRows, first, checkpoints);
      await glue.persist([first]);
      assert.equal(checkpoints.length, 1, 'score-safe checkpoint completes before publication');
      assert.ok(checkpoints[0].jobs[0].officialPosting.trail.includes('fetch-failed'));
      const cleaned = { ...first, snippet: 'Requirements include newly cleaned dispatch responsibilities.', salary: '$80 - $90 per hour' };
      const published = await glue.publish([cleaned, fresh]);
      assert.deepEqual(calls, [[first.url], [cleaned.url, fresh.url]]); assert.equal(handoffs, 2, 'the changed source and new row share one fresh research chunk');
      assert.equal(saves, 0); assert.equal(published.jobs[0].snippet, cleaned.snippet); assert.equal(published.jobs[0].salary, cleaned.salary);
      for (const field of ['title', 'company', 'location', 'url', 'source']) assert.equal(published.jobs[0][field], cleaned[field]);
      assert.equal(published.officialPosting.total, 3); assert.equal(published.officialPosting.handoffs, 2);
      await glue.publish([cleaned, fresh]); assert.equal(handoffs, 2);
    },
  },
  {
    name: 'R3 recovery receipt cannot reuse the same URL for a different company or location',
    async run() {
      const original = job('one'); const calls = [];
      const resolve = createOfficialPostingRecoveryPassResolver(async rows => { calls.push(rows); return result(rows.map(row => {
        const url = `https://official.test/jobs/${encodeURIComponent(`${row.company}-${row.location}`)}`;
        return { ...row, officialPosting: metadata({ employer: row.company, sourceUrl: url, officialApplyUrl: url }) };
      })); });
      await resolve([original]);
      const foreign = { ...original, company: 'Harbor Devices' };
      const remote = { ...original, location: 'Bayview, Ontario, Canada' };
      const output = await resolve([foreign, remote]);
      assert.deepEqual(calls.map(rows => rows.length), [1, 2]);
      assert.equal(output.jobs[0].company, foreign.company); assert.equal(output.jobs[0].officialPosting.employer, foreign.company);
      assert.equal(output.jobs[1].location, remote.location);
    },
  },
  {
    name: 'R3 recovery rejudges changed global fallback input without manufacturing metadata or storing it',
    async run() {
      const row = job('one'); let calls = 0;
      const resolve = createOfficialPostingRecoveryPassResolver(async rows => { calls++; return result(rows, { total: rows.length, failed: rows.length, outcomes: { failed: rows.length } }); });
      const initial = await resolve([row]); assert.equal(initial.jobs[0].officialPosting, undefined);
      const cleaned = { ...row, snippet: 'A newly cleaned description stays intact.' };
      const again = await resolve([cleaned]);
      assert.equal(calls, 2); assert.equal(again.jobs[0].officialPosting, undefined); assert.equal(again.jobs[0].snippet, cleaned.snippet);
      assert.equal(again.officialPosting.failed, 2); assert.equal(again.officialPosting.total, 2);
      await resolve([{ ...cleaned }]); assert.equal(calls, 2, 'an unchanged retry still reuses its own fallback receipt');
    },
  },
  {
    name: 'R3 recovery retains actual dedup provenance and never resurrects a dropped row when new official input replaces its mirror',
    async run() {
      const first = job('one'); const dropped = job('two'); const own = job('three', { url: metadata().sourceUrl }); let calls = 0;
      const resolve = createOfficialPostingRecoveryPassResolver(async rows => { calls++; return result(rows.map(row => ({ ...row, officialPosting: metadata() })), { total: rows.length }); });
      const initial = await resolve([first, dropped]); assert.equal(initial.jobs.length, 1); assert.equal(initial.officialDedupDropped, 1);
      const priorDrop = initial.officialDedupDrops[0]; assert.equal(priorDrop.dropped.url, dropped.url); assert.equal(priorDrop.stage, 'official-posting');
      const absentWinner = await resolve([dropped]); assert.equal(absentWinner.jobs.length, 0); assert.equal(calls, 1);
      const upgraded = await resolve([first, dropped, own]);
      assert.deepEqual(upgraded.jobs.map(row => row.url), [own.url]); assert.equal(calls, 2); assert.equal(upgraded.officialDedupDropped, 2);
      assert.deepEqual(upgraded.officialDedupDrops[0], priorDrop);
      assert.equal((await resolve([first, dropped])).jobs.length, 0); assert.equal(calls, 2);
    },
  },
  {
    name: 'R3 recovery preserves unresolved duplicate multiplicity unless actual official dedup records a drop',
    async run() {
      const row = job('one'); const calls = [];
      const resolve = createOfficialPostingRecoveryPassResolver(async rows => { calls.push(rows.length); return result(rows.map(value => ({ ...value,
        officialPosting: metadata({ level: 'L5', outcome: 'not-found' }) })), { total: rows.length }); });
      const initial = await resolve([row, { ...row }]); assert.equal(initial.jobs.length, 2); assert.equal(initial.officialDedupDropped, 0);
      const again = await resolve([{ ...row }, { ...row }]); assert.equal(again.jobs.length, 2); assert.deepEqual(calls, [2]);
      const extra = await resolve([{ ...row }, { ...row }, { ...row }]); assert.equal(extra.jobs.length, 3); assert.deepEqual(calls, [2, 1]);
      assert.equal(extra.officialDedupDropped, 0); assert.equal(extra.officialPosting.total, 3);
    },
  },
  {
    name: 'R3 recovery refuses cached pass publication after Stop without dispatching another resolution',
    async run() {
      const controller = new AbortController(); const row = job('one'); let calls = 0;
      const resolve = createOfficialPostingRecoveryPassResolver(async rows => { calls++; return result(rows); }, { signal: controller.signal });
      await resolve([row]);
      const reason = new Error('Stopped synthetic recovery pass'); controller.abort(reason);
      await assert.rejects(resolve([row]), error => error === reason);
      assert.equal(calls, 1);
    },
  },
];
