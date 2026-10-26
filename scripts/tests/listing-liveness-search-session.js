import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { __runWithIpcRequestContextForTests } from '../../electron/ipc/ipcUtils.js';
import { createListingLivenessSearchSession } from '../../electron/ipc/listingLivenessSearch.js';
import { createListingLivenessCalibrationStore } from '../../electron/ipc/listingLivenessCalibration.js';
import { LISTING_LIVENESS_RULES } from '../../electron/ipc/listingLiveness.js';
import {
  isListingLivenessBreakerTripped, memoListingVerdict, readListingVerdictMemo, recordListingEvidence,
  readOfficialExpiryCandidates, recordOfficialExpiryCandidates,
  officialExpiryCandidatesConfirmedClosed,
} from '../../electron/ipc/listingLivenessStore.js';

const linked = () => ({ enabled: true, link: { state: 'linked' }, chat: { pool: { active: false } } });
const page = (extra = {}) => ({
  board: 'linkedin', ruleKey: 'linkedin', requestedUrl: 'https://www.linkedin.com/jobs/view/123',
  finalUrl: 'https://www.linkedin.com/jobs/view/123', finalHostClass: 'aggregator',
  expectedTitle: 'Platform Engineer', expectedCompany: 'Northwind Labs', expectedLocation: 'Remote',
  title: 'Platform Engineer - Northwind Labs', h1: 'Platform Engineer',
  chromeText: 'Platform Engineer. Applications are open for this position. Recruitment is complete for this position.',
  descriptionText: 'Build platform services.', descriptionIsPage: false, closedHits: [],
  openSignals: [], jsonLd: { validThrough: '', isListed: null }, redirectedAway: false,
  titleMatchesPage: true, httpStatus: 200, ...extra,
});
const row = (id, verdict = 'pending', basis = 'neither', extra = {}) => ({
  source: 'linkedin', jobkey: `synthetic-${id}`, url: `https://www.linkedin.com/jobs/view/${id}`,
  title: 'Platform Engineer', company: 'Northwind Labs', location: 'Remote',
  listingLiveness: { verdict, basis, board: 'linkedin', at: '2026-10-26T12:00:00.000Z' }, ...extra,
});
const answerFor = (count, verdict = 'open', quote = 'Applications are open for this position.') => ({
  rows: Array.from({ length: count }, (_unused, index) => ({ id: `r${index + 1}`, verdict, quote })),
});
const contextRun = callback => __runWithIpcRequestContextForTests({ livenessEvidence: new Map() }, callback);
const record = (rows, evidence = page()) => rows.forEach(item => assert.equal(recordListingEvidence(item, evidence), true));
async function withCalibrationStore(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'synthetic-liveness-amendment-'));
  try { return await run(createListingLivenessCalibrationStore(root)); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}
const firedEvidence = (ruleId, extra = {}) => page({
  chromeText: 'Applications are open for this synthetic position.',
  closedHits: [], jsonLd: { validThrough: '', isListed: null },
  openSignals: [{ ruleId, state: 'shadow' }], ...extra,
});

export default [
  { name: 'deferred expiry candidate pages use the liveness AI with quote validation and keep open or unclear candidates unconfirmed', run: () => contextRun(async () => {
    const targets = ['closed', 'open', 'unclear'].map((verdict, index) => row(`expiry-${index}`, 'closed', 'structural', {
      officialPosting: { level: 'L5', outcome: 'not-found', employer: 'Northwind Labs', trail: ['bridge-research', 'closed'] },
    }));
    for (const [index, target] of targets.entries()) {
      const url = `https://careers.northwind.example.test/jobs/expiry-${index}`;
      const chromeText = index === 0 ? 'This job is no longer available. The synthetic position has been filled.'
        : 'Applications are open for this position. The synthetic role is accepting applicants.';
      assert.equal(recordOfficialExpiryCandidates(target, [{ url, evidence: page({ board: 'generic', ruleKey: 'generic',
        requestedUrl: url, finalUrl: url, finalHostClass: 'ats', chromeText,
        jsonLd: { validThrough: '2000-01-01T00:00:00Z', isListed: null },
      }) }]), true);
    }
    let calls = 0;
    const session = createListingLivenessSearchSession({ bridgeStatus: linked,
      callText: async (_prompt, options) => {
        calls++;
        return options.responseValidator({ rows: [
          { id: 'r1', verdict: 'closed', quote: 'This job is no longer available.' },
          { id: 'r2', verdict: 'open', quote: 'Applications are open for this position.' },
          { id: 'r3', verdict: 'unclear', quote: '' },
        ] });
      } });
    await session.classifyExpiryCandidates(targets);
    assert.equal(calls, 1);
    assert.deepEqual(targets.map(target => readOfficialExpiryCandidates(target)[0].verdict), ['closed', 'open', 'unclear']);
    assert.equal(session.telemetry().listingLiveness.linkedin.expiryCandidatesConfirmedClosed, 1);
    assert.equal(session.telemetry().listingLiveness.linkedin.expiryCandidatesNotConfirmed, 2);
  }) },
  { name: 'deferred expiry overflow and invalid AI quotes never turn candidate pages into confirmed closed copies', run: () => contextRun(async () => {
    const target = row('expiry-overflow', 'closed', 'structural', { officialPosting: {
      level: 'L5', outcome: 'not-found', employer: 'Northwind Labs', trail: ['bridge-research', 'closed'],
    } });
    const candidates = Array.from({ length: 9 }, (_, index) => {
      const url = `https://careers.northwind.example.test/jobs/overflow-${index}`;
      return { url, evidence: page({ board: 'generic', ruleKey: 'generic', requestedUrl: url, finalUrl: url,
        httpStatus: 404, chromeText: 'This synthetic job page is unavailable.' }) };
    });
    assert.equal(recordOfficialExpiryCandidates(target, candidates), true);
    let calls = 0;
    const session = createListingLivenessSearchSession({ bridgeStatus: linked,
      callText: async () => { calls++; return answerFor(1); } });
    await session.classifyExpiryCandidates([target]);
    assert.equal(calls, 0, 'structural HTTP closure needs no AI');
    assert.equal(readOfficialExpiryCandidates(target).length, 8);
    assert.equal(officialExpiryCandidatesConfirmedClosed(target), false, 'an unexamined overflow candidate blocks settlement');
    const single = row('expiry-invalid-quote', 'closed', 'structural', { officialPosting: target.officialPosting });
    const url = 'https://careers.northwind.example.test/jobs/invalid-quote';
    recordOfficialExpiryCandidates(single, [{ url, evidence: page({ board: 'generic', ruleKey: 'generic',
      requestedUrl: url, finalUrl: url, chromeText: 'This job is no longer available. '.repeat(5),
      jsonLd: { validThrough: '2000-01-01T00:00:00Z', isListed: null },
    }) }]);
    const invalid = createListingLivenessSearchSession({ bridgeStatus: linked,
      callText: async () => ({ rows: [{ id: 'r1', verdict: 'closed', quote: 'A fabricated closure quote.' }] }) });
    await invalid.classifyExpiryCandidates([single]);
    assert.equal(officialExpiryCandidatesConfirmedClosed(single), false);
    assert.equal(invalid.telemetry().listingLiveness.linkedin.expiryCandidatesNotConfirmed, 1);
  }) },
  { name: 'liveness search uses one linked-status read, serial sorted chunks of at most eight, and accepts reordered answer ids', run: () => contextRun(async () => {
    const rows = Array.from({ length: 9 }, (_unused, index) => row(9 - index));
    record(rows);
    let statusReads = 0; let active = 0; let peak = 0;
    const calls = [];
    const session = createListingLivenessSearchSession({
      bridgeStatus: async () => { statusReads++; return linked(); },
      callText: async (_prompt, opts) => {
        active++; peak = Math.max(peak, active);
        calls.push({ ...opts.hints });
        await new Promise(resolve => setTimeout(resolve, 2));
        active--;
        const answer = answerFor(opts.hints.itemCount);
        answer.rows.reverse();
        return answer;
      }, now: Date.now,
    });
    const stamped = await session.classifyPrimary(rows);
    assert.equal(statusReads, 1);
    assert.equal(peak, 1);
    assert.deepEqual(calls.map(call => [call.itemCount, call.batch, call.batchTotal]), [[8, 1, 2], [1, 2, 2]]);
    assert.ok(stamped.every(item => item.listingLiveness.verdict === 'open' && item.listingLiveness.basis === 'ai'));
    assert.deepEqual(stamped.map(item => item.jobkey), rows.map(item => item.jobkey), 'input order is preserved');
    assert.equal(session.telemetry().listingLiveness.linkedin.aiChecked, 9);
    assert.equal(session.telemetry().handoffStats.handoffs, 2);
  }) },
  { name: 'liveness search invalid first chunk trips the request breaker and leaves later seam pending', run: () => contextRun(async () => {
    const rows = Array.from({ length: 9 }, (_unused, index) => row(index + 1));
    record(rows);
    let calls = 0;
    const options = { bridgeStatus: linked, callText: async (_prompt, opts) => {
      calls++; return answerFor(opts.hints.itemCount, 'closed', 'This quote was not on the supplied page.');
    } };
    const first = createListingLivenessSearchSession(options);
    assert.ok((await first.classifyPrimary(rows)).every(item => item.listingLiveness.verdict === 'pending'));
    assert.equal(calls, 1);
    assert.equal(isListingLivenessBreakerTripped(), true);
    assert.equal(first.telemetry().listingLiveness.linkedin.aiPending, 9);
    const second = createListingLivenessSearchSession(options);
    assert.ok((await second.classifyPrimary(rows)).every(item => item.listingLiveness.verdict === 'pending'));
    assert.equal(calls, 1);
  }) },
  { name: 'liveness search local breaker stops later chunks if request evidence storage disappears', run: async () => {
    const context = { livenessEvidence: new Map() };
    await __runWithIpcRequestContextForTests(context, async () => {
      const rows = Array.from({ length: 9 }, (_unused, index) => row(index + 1)); record(rows);
      let calls = 0;
      const session = createListingLivenessSearchSession({ bridgeStatus: linked,
        callText: async (_prompt, options) => {
          calls++;
          context.livenessEvidence = null;
          return answerFor(options.hints.itemCount, 'closed', 'This quote is absent from the supplied page.');
        } });
      const checked = await session.classifyPrimary(rows);
      assert.equal(calls, 1, 'the local breaker still stops the next chunk');
      assert.ok(checked.every(item => item.listingLiveness.verdict === 'pending'));
    });
  } },
  { name: 'liveness search not-linked status trips breaker without sending to a worker', run: () => contextRun(async () => {
    const rows = [row(1)]; record(rows);
    let reads = 0; let calls = 0;
    const session = createListingLivenessSearchSession({ bridgeStatus: () => { reads++; return { enabled: true, link: { state: 'pairing' } }; },
      callText: async () => { calls++; return answerFor(1); } });
    assert.equal((await session.classifyPrimary(rows))[0].listingLiveness.verdict, 'pending');
    assert.equal(reads, 1); assert.equal(calls, 0); assert.equal(isListingLivenessBreakerTripped(), true);
  }) },
  { name: 'liveness search shared budget leaves alternates pending after primary consumes it', run: () => contextRun(async () => {
    const primary = row(1); const alternate = row(2); record([primary, alternate]);
    let clock = 0; let calls = 0;
    const session = createListingLivenessSearchSession({ bridgeStatus: linked, now: () => clock,
      callText: async (_prompt, opts) => { calls++; clock = 600_001; return answerFor(opts.hints.itemCount); } });
    assert.equal((await session.classifyPrimary([primary]))[0].listingLiveness.verdict, 'open');
    assert.equal((await session.classifyAlternates([alternate]))[0].listingLiveness.verdict, 'pending');
    assert.equal(calls, 1);
    assert.equal(session.telemetry().listingLiveness.linkedin.aiPending, 1);
    assert.equal(isListingLivenessBreakerTripped(), false);
  }) },
  { name: 'liveness search run abort rethrows its reason and returns no stamped rows or memo', run: () => contextRun(async () => {
    const rows = [row(1)]; record(rows);
    const controller = new AbortController(); const reason = new Error('synthetic run reset');
    const session = createListingLivenessSearchSession({ bridgeStatus: linked, signal: controller.signal,
      callText: async (_prompt, opts) => { controller.abort(reason); return answerFor(opts.hints.itemCount); } });
    await assert.rejects(session.classifyPrimary(rows), error => error === reason);
    assert.equal(rows[0].listingLiveness.verdict, 'pending');
    assert.equal(readListingVerdictMemo(rows[0]), null);
  }) },
  { name: 'liveness search second seam uses request memo without another handoff or calibration write', run: () => contextRun(async () => {
    const rows = [row(1)]; record(rows);
    let calls = 0; let calibrations = 0;
    const options = { bridgeStatus: linked, callText: async (_prompt, opts) => { calls++; return answerFor(opts.hints.itemCount); },
      calibrationStore: { recordAiAnswer: async () => { calibrations++; return { promoted: [], demoted: [] }; } } };
    assert.equal((await createListingLivenessSearchSession(options).classifyPrimary(rows))[0].listingLiveness.verdict, 'open');
    assert.equal((await createListingLivenessSearchSession(options).classifyPrimary(rows))[0].listingLiveness.verdict, 'open');
    assert.equal(calls, 1); assert.equal(calibrations, 1);
  }) },
  { name: 'liveness search audited close suspends active rule and rechecks every other candidate in phase B', run: () => contextRun(async () => {
    const rows = Array.from({ length: 9 }, (_unused, index) => row(index + 1, 'open', 'open-marker'));
    record(rows, page({ openSignals: [{ ruleId: 'linkedin-enabled-apply', state: 'active' }] }));
    const invocations = []; const demotions = []; let calibrationCalls = 0;
    const session = createListingLivenessSearchSession({ bridgeStatus: linked,
      callText: async (_prompt, opts) => {
        invocations.push(opts.hints.itemCount);
        return invocations.length === 1
          ? { rows: [{ id: 'r1', verdict: 'closed', quote: 'Recruitment is complete for this position.' },
            { id: 'r2', verdict: 'open', quote: 'Applications are open for this position.' }] }
          : answerFor(opts.hints.itemCount);
      },
      calibrationStore: {
        recordAiAnswer: async ({ verdict }) => { calibrationCalls++; return { promoted: [], demoted: verdict === 'closed' ? ['linkedin-enabled-apply'] : [] }; },
        demoteRule: async options => { demotions.push(options); return {}; },
      }, now: () => 1_000_000,
    });
    const checked = await session.classifyPrimary(rows);
    assert.deepEqual(invocations, [2, 8]);
    assert.equal(checked[0].listingLiveness.verdict, 'closed');
    assert.ok(checked.slice(1).every(item => item.listingLiveness.verdict === 'open' && item.listingLiveness.basis === 'ai'));
    assert.equal(calibrationCalls, 10);
    assert.equal(demotions.length, 1);
    assert.equal(demotions[0].suspendedUntil - demotions[0].now, 7 * 24 * 60 * 60 * 1_000);
    const counts = session.telemetry().listingLiveness.linkedin;
    assert.equal(counts.auditChecked, 10); assert.equal(counts.auditDisagreed, 1);
    assert.equal(counts.ruleDemoted, 1); assert.equal(counts.aiChecked, 10);
    let reasks = 0;
    const again = createListingLivenessSearchSession({ bridgeStatus: linked, callText: async () => { reasks++; return answerFor(1); } });
    const memoed = await again.classifyPrimary(rows);
    assert.equal(reasks, 0);
    assert.equal(memoed[0].listingLiveness.verdict, 'closed');
    assert.ok(memoed.slice(1).every(item => item.listingLiveness.verdict === 'open'));
  }) },
  { name: 'liveness search ordinary chunk error preserves resolved postings and continues siblings', run: () => contextRun(async () => {
    const posting = { level: 'L5', outcome: 'failed', employer: 'Northwind Labs', trail: ['failed'] };
    const rows = Array.from({ length: 9 }, (_unused, index) => row(index + 1, 'pending', 'neither', { officialPosting: posting }));
    record(rows);
    let calls = 0;
    const session = createListingLivenessSearchSession({ bridgeStatus: linked, callText: async (_prompt, opts) => {
      calls++;
      if (calls === 1) throw Object.assign(new Error('Synthetic transport interruption'), { code: 'NETWORK_INTERRUPTED' });
      return answerFor(opts.hints.itemCount);
    } });
    const checked = await session.classifyPrimary(rows);
    assert.equal(calls, 2);
    assert.ok(checked.slice(0, 8).every(item => item.listingLiveness.verdict === 'pending'));
    assert.equal(checked[8].listingLiveness.verdict, 'open');
    assert.ok(checked.every(item => item.officialPosting === posting));
    assert.equal(session.telemetry().listingLiveness.linkedin.aiPending, 8);
  }) },
  { name: 'liveness search skips L1–L4 pending rows and counts only the skipped board', run: () => contextRun(async () => {
    const posting = { level: 'L2', outcome: 'found', employer: 'Northwind Labs', title: 'Platform Engineer',
      location: { display: 'Remote' }, salary: { text: '', provenance: 'unknown' },
      sourceUrl: 'https://careers.northwind.example.test/jobs/platform',
      officialApplyUrl: 'https://careers.northwind.example.test/jobs/platform', ats: 'ashby', tenant: 'northwind',
      fetchedAt: '2026-10-26T12:00:00.000Z', contentHash: 'a'.repeat(64), trail: ['careers-page'] };
    const rows = [row(1, 'pending', 'closed-marker', { officialPosting: posting })]; record(rows);
    let calls = 0;
    const session = createListingLivenessSearchSession({ bridgeStatus: linked,
      callText: async () => { calls++; return answerFor(1); } });
    assert.equal((await session.classifyPrimary(rows))[0].listingLiveness.verdict, 'pending');
    assert.equal(calls, 0);
    assert.equal(session.telemetry().listingLiveness.linkedin.aiSkippedOfficial, 1);
  }) },
  { name: 'liveness search forwards the run abort into an already in-flight handoff', run: () => contextRun(async () => {
    const target = row('abort-live'); record([target]);
    const controller = new AbortController(); const reason = new Error('synthetic reset');
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    const session = createListingLivenessSearchSession({ bridgeStatus: linked, signal: controller.signal,
      callText: (_prompt, options) => {
        entered();
        return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
      } });
    const pending = session.classifyPrimary([target]);
    await started;
    controller.abort(reason);
    const outcome = await Promise.race([
      pending.then(() => 'resolved', error => error === reason ? 'aborted' : `wrong:${error?.message}`),
      new Promise(resolve => setTimeout(() => resolve('hung'), 250)),
    ]);
    assert.equal(outcome, 'aborted');
  }) },
  { name: 'liveness search sorts evidence keys before dividing the primary batch into chunks', run: () => contextRun(async () => {
    const rows = Array.from({ length: 9 }, (_unused, index) => row(9 - index, 'pending', 'neither', { title: `Synthetic Role ${9 - index}` }));
    for (const item of rows) assert.equal(recordListingEvidence(item, page({ expectedTitle: item.title,
      title: item.title, h1: item.title, requestedUrl: item.url, finalUrl: item.url })), true);
    const prompts = [];
    const session = createListingLivenessSearchSession({ bridgeStatus: linked,
      callText: async (prompt, options) => { prompts.push(prompt); return answerFor(options.hints.itemCount); } });
    await session.classifyPrimary(rows);
    assert.equal(prompts.length, 2);
    assert.ok(prompts[0].includes('Synthetic Role 1') && prompts[0].includes('Synthetic Role 8'));
    assert.equal(prompts[0].includes('Synthetic Role 9'), false);
    assert.ok(prompts[1].includes('Synthetic Role 9'));
  }) },
  { name: 'liveness search uses only the remaining shared budget for each later handoff', run: () => contextRun(async () => {
    const rows = Array.from({ length: 9 }, (_unused, index) => row(index + 1)); record(rows);
    let clock = 0; let calls = 0;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('synthetic timeout guard')), 800);
    try {
      const session = createListingLivenessSearchSession({ bridgeStatus: linked, signal: controller.signal, now: () => clock,
        callText: async (_prompt, options) => {
          calls++;
          if (calls === 1) { clock = 599_950; return answerFor(options.hints.itemCount); }
          return new Promise(() => {});
        } });
      const checked = await session.classifyPrimary(rows);
      assert.equal(calls, 2);
      assert.ok(checked.slice(0, 8).every(item => item.listingLiveness.verdict === 'open'));
      assert.equal(checked[8].listingLiveness.verdict, 'pending');
      assert.equal(isListingLivenessBreakerTripped(), true, 'the 50 ms remainder times out the second handoff');
    } finally { clearTimeout(timeout); }
  }) },
  { name: 'recording new listing evidence clears the prior request-local verdict memo', run: () => contextRun(() => {
    const target = row('memo');
    assert.equal(recordListingEvidence(target, page()), true);
    assert.equal(memoListingVerdict(target, 'open'), true);
    assert.equal(readListingVerdictMemo(target), 'open');
    assert.equal(recordListingEvidence(target, page({ chromeText: 'A new synthetic page.' })), true);
    assert.equal(readListingVerdictMemo(target), null);
  }) },
  { name: 'liveness audit excludes L1–L4 open-marker rows before sampling', run: () => contextRun(async () => {
    const officialPosting = { level: 'L2', outcome: 'found', employer: 'Northwind Labs', title: 'Platform Engineer',
      location: { display: 'Remote' }, salary: { text: '', provenance: 'unknown' },
      sourceUrl: 'https://careers.northwind.example.test/jobs/platform',
      officialApplyUrl: 'https://careers.northwind.example.test/jobs/platform', ats: 'ashby', tenant: 'northwind',
      fetchedAt: '2026-10-26T12:00:00.000Z', contentHash: 'a'.repeat(64), trail: ['careers-page'] };
    const target = row('official-audit', 'open', 'open-marker', { officialPosting }); record([target]);
    let calls = 0;
    const session = createListingLivenessSearchSession({ bridgeStatus: linked,
      callText: async () => { calls++; return answerFor(1); } });
    assert.equal((await session.classifyPrimary([target]))[0].listingLiveness.verdict, 'open');
    assert.equal(calls, 0);
  }) },
  { name: 'liveness audit candidates require open-marker basis and stored page evidence', run: () => contextRun(async () => {
    const aiOpen = row('a-ai-open', 'open', 'ai', { title: 'Synthetic AI Open Role' });
    const missing = row('b-no-evidence', 'open', 'open-marker', { title: 'Synthetic Missing Evidence Role' });
    const marker = row('z-marker', 'open', 'open-marker', { title: 'Synthetic Marker Role' });
    for (const item of [aiOpen, marker]) assert.equal(recordListingEvidence(item, page({
      requestedUrl: item.url, finalUrl: item.url, expectedTitle: item.title, title: item.title, h1: item.title,
    })), true);
    const prompts = [];
    const session = createListingLivenessSearchSession({ bridgeStatus: linked,
      callText: async (prompt, options) => { prompts.push(prompt); return answerFor(options.hints.itemCount); } });
    const checked = await session.classifyPrimary([aiOpen, missing, marker]);
    assert.equal(prompts.length, 1);
    assert.ok(prompts[0].includes(marker.title), 'only the evidenced marker enters Phase A');
    assert.equal(prompts[0].includes(aiOpen.title), false, 'an AI-open row is not audited again');
    assert.equal(prompts[0].includes(missing.title), false, 'a row without page evidence is not audited');
    assert.equal(checked[0].listingLiveness.basis, 'ai');
    assert.equal(checked[1].listingLiveness.basis, 'open-marker');
  }) },
  { name: 'liveness audit demotion requires an audited member, not an ordinary AI-closed answer', run: () => contextRun(async () => {
    const target = row('pending-active', 'pending', 'neither');
    record([target], page({ openSignals: [{ ruleId: 'linkedin-enabled-apply', state: 'active' }] }));
    let demotions = 0;
    const session = createListingLivenessSearchSession({ bridgeStatus: linked,
      callText: async () => ({ rows: [{ id: 'r1', verdict: 'closed', quote: 'Recruitment is complete for this position.' }] }),
      calibrationStore: { recordAiAnswer: async () => ({ promoted: [], demoted: [] }),
        demoteRule: async () => { demotions++; return {}; } } });
    const checked = await session.classifyPrimary([target]);
    assert.equal(checked[0].listingLiveness.verdict, 'closed');
    assert.equal(demotions, 0, 'an ordinary closed answer cannot suspend a calibrated open rule');
  }) },
  { name: 'liveness audit Phase A selects sorted per-board evidence keys with a stable index tiebreak', run: () => contextRun(async () => {
    const ids = [9, 2, 3, 4, 5, 6, 7, 1, 8];
    const rows = ids.map(id => row(`audit-${id}`, 'open', 'open-marker', { title: `Synthetic Audit Role ${id}` }));
    for (const item of rows) assert.equal(recordListingEvidence(item, page({ requestedUrl: item.url,
      finalUrl: item.url, expectedTitle: item.title, title: item.title, h1: item.title })), true);
    const prompts = [];
    const session = createListingLivenessSearchSession({ bridgeStatus: linked,
      callText: async (prompt, options) => { prompts.push(prompt); return answerFor(options.hints.itemCount); } });
    await session.classifyPrimary(rows);
    assert.equal(prompts.length, 1);
    assert.ok(prompts[0].includes('Synthetic Audit Role 1'));
    assert.ok(prompts[0].includes('Synthetic Audit Role 9'));
    assert.equal(prompts[0].includes('Synthetic Audit Role 8'), false, 'the unsorted last input is not the ninth key');
    // Equal keys retain input-index order under modern stable sorting. Pin the
    // explicit tiebreak so that the deterministic policy remains visible.
    const source = await fs.readFile(new URL('../../electron/ipc/listingLivenessSearch.js', import.meta.url), 'utf8');
    assert.match(source, /group\.sort\(\(a, b\) => a\.key\.localeCompare\(b\.key\) \|\| a\.index - b\.index\);/u);
  }) },
  { name: 'liveness audit samples each board and resets only the disagreed board for an unanswered Phase B', run: () => contextRun(async () => {
    const make = (board, index) => {
      const item = row(`${board}-${index}`, 'open', 'open-marker', {
        source: board, url: board === 'indeed' ? `https://www.indeed.com/viewjob?jk=synthetic-${index}`
          : `https://www.linkedin.com/jobs/view/synthetic-${index}`,
        title: `Synthetic ${board} Role ${index}`,
        listingLiveness: { verdict: 'open', basis: 'open-marker', board, at: '2026-10-26T12:00:00.000Z' },
      });
      assert.equal(recordListingEvidence(item, page({ board, ruleKey: board,
        requestedUrl: item.url, finalUrl: item.url, expectedTitle: item.title,
        title: item.title, h1: item.title,
        openSignals: [{ ruleId: `${board}-enabled-apply`, state: 'active' }] })), true);
      return item;
    };
    const indeedRows = Array.from({ length: 7 }, (_unused, index) => make('indeed', index + 1));
    const linkedinRows = Array.from({ length: 8 }, (_unused, index) => make('linkedin', index + 1));
    const prompts = []; let demotions = 0;
    const session = createListingLivenessSearchSession({ bridgeStatus: linked,
      callText: async (prompt, options) => {
        prompts.push({ prompt, count: options.hints.itemCount });
        if (prompts.length === 1) {
          assert.equal(memoListingVerdict(indeedRows[1], 'open'), true, 'set a stale memo after Phase A selected its sample');
          return { rows: [{ id: 'r1', verdict: 'closed', quote: 'Recruitment is complete for this position.' },
            { id: 'r2', verdict: 'open', quote: 'Applications are open for this position.' }] };
        }
        throw Object.assign(new Error('synthetic Phase B interruption'), { code: 'NETWORK_INTERRUPTED' });
      },
      calibrationStore: { recordAiAnswer: async () => ({ promoted: [], demoted: [] }),
        demoteRule: async () => { demotions++; return {}; } },
    });
    const checked = await session.classifyPrimary([...indeedRows, ...linkedinRows]);
    assert.deepEqual(prompts.map(item => item.count), [2, 6], 'Phase A samples one per board and Phase B only the six other Indeed rows');
    assert.ok(prompts[0].prompt.includes('Synthetic linkedin Role 1'), 'each board samples its own first evidence key');
    assert.equal(prompts[0].prompt.includes('Synthetic linkedin Role 2'), false);
    assert.ok(prompts[1].prompt.includes('Synthetic indeed Role 2'));
    assert.equal(prompts[1].prompt.includes('Synthetic linkedin Role'), false, 'other boards never enter Phase B');
    assert.equal(checked[0].listingLiveness.verdict, 'closed');
    assert.ok(checked.slice(1, 7).every(item => item.listingLiveness.verdict === 'pending' && item.listingLiveness.basis === 'neither'));
    assert.ok(checked.slice(7).every(item => item.listingLiveness.verdict === 'open'));
    assert.equal(readListingVerdictMemo(indeedRows[1]), null, 'Phase B recording clears the stale answer');
    assert.equal(demotions, 1);
  }) },
  { name: 'liveness audit never demotes from an invalid empty closed quote', run: () => contextRun(async () => {
    const target = row('empty-quote', 'open', 'open-marker');
    record([target], page({ openSignals: [{ ruleId: 'linkedin-enabled-apply', state: 'active' }] }));
    let demotions = 0;
    const session = createListingLivenessSearchSession({ bridgeStatus: linked,
      callText: async () => ({ rows: [{ id: 'r1', verdict: 'closed', quote: '' }] }),
      calibrationStore: { recordAiAnswer: async () => ({ promoted: [], demoted: [] }),
        demoteRule: async () => { demotions++; return {}; } } });
    const checked = await session.classifyPrimary([target]);
    assert.equal(checked[0].listingLiveness.verdict, 'open');
    assert.equal(demotions, 0);
    // The validator rejects this response first. Preserve the second guard at
    // the demotion call site for future validators that admit empty quotes.
    const source = await fs.readFile(new URL('../../electron/ipc/listingLivenessSearch.js', import.meta.url), 'utf8');
    assert.match(source, /response\.verdict === 'closed' && response\.quote\.trim\(\) !== ''/u);
  }) },
  { name: 'liveness audit demotes only a rule active on the captured page', run: () => contextRun(async () => {
    const target = row('shadow-signal', 'open', 'open-marker');
    record([target], page({ openSignals: [{ ruleId: 'linkedin-enabled-apply', state: 'shadow' }] }));
    let demotions = 0;
    const session = createListingLivenessSearchSession({ bridgeStatus: linked,
      callText: async () => ({ rows: [{ id: 'r1', verdict: 'closed', quote: 'Recruitment is complete for this position.' }] }),
      calibrationStore: { recordAiAnswer: async () => ({ promoted: [], demoted: [] }),
        demoteRule: async () => { demotions++; return {}; } } });
    assert.equal((await session.classifyPrimary([target]))[0].listingLiveness.verdict, 'closed');
    assert.equal(demotions, 0, 'a shadow control cannot be demoted as an active false-open rule');
  }) },
  { name: 'liveness calibration stays shadow at each individual promotion boundary and on null title match', async run() {
    const ruleId = LISTING_LIVENESS_RULES.linkedin.openRules[0].id;
    const fired = firedEvidence(ruleId);
    const silent = firedEvidence(ruleId, { openSignals: [] });
    const stateOf = async store => (await store.snapshot()).boards.linkedin.rules[ruleId];
    await withCalibrationStore(async store => {
      for (let index = 0; index < 19; index++) await store.recordAiAnswer({ ruleKey: 'linkedin', evidence: fired, verdict: 'open' });
      for (let index = 0; index < 5; index++) await store.recordAiAnswer({ ruleKey: 'linkedin', evidence: silent, verdict: 'closed' });
      for (let index = 0; index < 16; index++) await store.recordAiAnswer({ ruleKey: 'linkedin', evidence: silent, verdict: 'unclear' });
      assert.equal((await stateOf(store)).state, 'shadow', '19 fired open answers do not promote');
      assert.equal((await stateOf(store)).firedAndAiOpen, 19);
      await store.recordAiAnswer({ ruleKey: 'linkedin', evidence: fired, verdict: 'open' });
      assert.equal((await stateOf(store)).state, 'active', 'the twentieth fired open answer promotes');
      const later = await store.recordAiAnswer({ ruleKey: 'linkedin', evidence: fired, verdict: 'open' });
      assert.deepEqual(later.promoted, [], 'an already active rule is not promoted again');
    });
    await withCalibrationStore(async store => {
      for (let index = 0; index < 20; index++) await store.recordAiAnswer({ ruleKey: 'linkedin', evidence: fired, verdict: 'open' });
      for (let index = 0; index < 4; index++) await store.recordAiAnswer({ ruleKey: 'linkedin', evidence: silent, verdict: 'closed' });
      for (let index = 0; index < 16; index++) await store.recordAiAnswer({ ruleKey: 'linkedin', evidence: silent, verdict: 'unclear' });
      assert.equal((await stateOf(store)).state, 'shadow', 'four silent closed answers do not promote');
      assert.equal((await stateOf(store)).silentOnAiClosed, 4);
      await store.recordAiAnswer({ ruleKey: 'linkedin', evidence: silent, verdict: 'closed' });
      assert.equal((await stateOf(store)).state, 'active', 'the fifth silent closed answer promotes');
    });
    await withCalibrationStore(async store => {
      await store.recordAiAnswer({ ruleKey: 'linkedin', evidence: firedEvidence(ruleId, { titleMatchesPage: null }), verdict: 'open' });
      assert.equal((await stateOf(store)).firedAndAiOpen, 0, 'an unknown title match is ineligible');
      await store.recordAiAnswer({ ruleKey: 'linkedin', evidence: firedEvidence(ruleId, {
        closedHits: [{ ruleId: 'synthetic-closed-banner', insideDescription: false, context: 'Position closed.' }],
      }), verdict: 'closed' });
      assert.equal((await stateOf(store)).silentOnAiClosed, 0, 'a fired rule is never also a silent miss');
    });
  } },
  { name: 'latest demotion selects the newest rule timestamp when a board gains multiple rules', async run() {
    // Each board currently has one rule, so keep a narrow source guard for the
    // multi-rule ordering invariant until a second candidate rule ships.
    const source = await fs.readFile(new URL('../../electron/ipc/listingLivenessCalibration.js', import.meta.url), 'utf8');
    assert.match(source, /\.filter\(Boolean\)\.sort\(\)\.at\(-1\) \|\| null/u);
  } },
  { name: 'liveness audit demotes a real active rule, suspends it for seven days, and blocks early re-promotion', async run() {
    const ruleId = LISTING_LIVENESS_RULES.linkedin.openRules[0].id;
    const at = Date.parse('2026-10-26T12:00:00.000Z');
    const fired = firedEvidence(ruleId);
    const silent = firedEvidence(ruleId, { openSignals: [] });
    await withCalibrationStore(async store => {
      for (let index = 0; index < 20; index++) await store.recordAiAnswer({ ruleKey: 'linkedin', evidence: fired, verdict: 'open', now: at });
      for (let index = 0; index < 5; index++) await store.recordAiAnswer({ ruleKey: 'linkedin', evidence: silent, verdict: 'closed', now: at });
      for (let index = 0; index < 15; index++) await store.recordAiAnswer({ ruleKey: 'linkedin', evidence: silent, verdict: 'unclear', now: at });
      assert.equal((await store.snapshot()).rulesFor('linkedin').openRules[0].state, 'active');
      await contextRun(async () => {
        const target = row('real-store-audit', 'open', 'open-marker');
        record([target], page({ openSignals: [{ ruleId, state: 'active' }] }));
        const session = createListingLivenessSearchSession({ bridgeStatus: linked, calibrationStore: store, now: () => at,
          callText: async () => ({ rows: [{ id: 'r1', verdict: 'closed', quote: 'Recruitment is complete for this position.' }] }) });
        assert.equal((await session.classifyPrimary([target]))[0].listingLiveness.verdict, 'closed');
      });
      const demoted = (await store.snapshot()).boards.linkedin.rules[ruleId];
      assert.equal(demoted.state, 'shadow');
      assert.equal(demoted.demotedAt, new Date(at).toISOString());
      assert.equal(Date.parse(demoted.suspendedUntil) - at, 7 * 24 * 60 * 60 * 1_000);
      assert.equal(await store.latestDemotedAt('linkedin'), demoted.demotedAt);
      for (let index = 0; index < 20; index++) await store.recordAiAnswer({ ruleKey: 'linkedin', evidence: fired, verdict: 'open', now: at + 86_400_000 });
      for (let index = 0; index < 5; index++) await store.recordAiAnswer({ ruleKey: 'linkedin', evidence: silent, verdict: 'closed', now: at + 86_400_000 });
      for (let index = 0; index < 15; index++) await store.recordAiAnswer({ ruleKey: 'linkedin', evidence: silent, verdict: 'unclear', now: at + 86_400_000 });
      assert.equal((await store.snapshot()).rulesFor('linkedin').openRules[0].state, 'shadow');
    });
  } },
];
