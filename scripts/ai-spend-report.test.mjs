// Annualization in the spend report: every call id annualizes over the window of
// the log source it came from (all usage rows share one window, all counted run
// rows share another), never over its own first-to-last call window.
import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeAiSpend } from './ai-spend-report.mjs';

const byId = summary => Object.fromEntries(summary.calls.map(call => [call.id, call]));

test('spend report: usage calls share one usage-log window', () => {
  const summary = summarizeAiSpend({
    usageRows: [
      { at: '2026-01-01T00:00:00.000Z', task: 'job-scoring', costUsd: 1, model: 'claude-a', effort: 'low' },
      { at: '2026-01-11T00:00:00.000Z', task: 'job-scoring', costUsd: 1, model: 'claude-a', effort: 'low' },
      { at: '2026-01-10T00:00:00.000Z', task: 'job-matching', costUsd: 2, model: 'claude-a', effort: 'low' },
      { at: '2026-01-10T06:00:00.000Z', task: 'job-matching', costUsd: 2, model: 'claude-a', effort: 'low' },
    ],
  });
  const calls = byId(summary);
  assert.deepEqual(calls['job-scoring'],
    { id: 'job-scoring', calls: 2, totalCostUsd: 2, windowDays: 10, annualCostUsd: 73 });
  assert.deepEqual(calls['job-matching'],
    { id: 'job-matching', calls: 2, totalCostUsd: 4, windowDays: 10, annualCostUsd: 146 },
    'a burst inside one day annualizes over the 10-day log, not over its own shorter span');
  assert.deepEqual(summary.calls.map(call => call.id), ['job-matching', 'job-scoring'], 'sorted by annual cost');
});

test('spend report: run rows keep a window of their own', () => {
  const summary = summarizeAiSpend({
    usageRows: [
      { at: '2026-02-01T00:00:00.000Z', task: 'job-scoring', costUsd: 1 },
      { at: '2026-02-11T00:00:00.000Z', task: 'job-scoring', costUsd: 1 },
    ],
    runRows: [
      { at: '2026-02-11T00:00:00.000Z', stage: 'cover-letter', costUsd: 1 },
      { at: '2026-02-15T00:00:00.000Z', stage: 'cover-letter', costUsd: 1 },
    ],
  });
  const calls = byId(summary);
  assert.deepEqual(calls['job-scoring'],
    { id: 'job-scoring', calls: 2, totalCostUsd: 2, windowDays: 10, annualCostUsd: 73 },
    'run rows do not stretch the usage window');
  assert.deepEqual(calls['stage:cover-letter'],
    { id: 'stage:cover-letter', calls: 2, totalCostUsd: 2, windowDays: 4, annualCostUsd: 182.5, costedCalls: 2 },
    'run rows use their own 4-day span, not the 10-day usage span');
});

test('spend report: a single row annualizes over one day', () => {
  const now = Date.parse('2026-03-01T00:00:00.000Z');
  const summary = summarizeAiSpend({
    now,
    usageRows: [
      { at: '2026-03-01T00:00:00.000Z', task: 'job-scoring', costUsd: 0.5 },
      // No parseable time: the row sits at `now`, so the usage source still spans one day.
      { task: 'job-matching', costUsd: 0.25 },
    ],
    runRows: [
      { at: '2026-03-01T00:00:00.000Z', stage: 'cover-letter', costUsd: 2 },
    ],
  });
  const calls = byId(summary);
  assert.deepEqual(calls['job-scoring'],
    { id: 'job-scoring', calls: 1, totalCostUsd: 0.5, windowDays: 1, annualCostUsd: 182.5 });
  assert.deepEqual(calls['job-matching'],
    { id: 'job-matching', calls: 1, totalCostUsd: 0.25, windowDays: 1, annualCostUsd: 91.25 });
  assert.deepEqual(calls['stage:cover-letter'],
    { id: 'stage:cover-letter', calls: 1, totalCostUsd: 2, windowDays: 1, annualCostUsd: 730, costedCalls: 1 });
});

test('spend report: a partly costed stage annualizes its mean cost over the run window', () => {
  const summary = summarizeAiSpend({
    runRows: [
      { at: '2026-06-01T00:00:00.000Z', stage: 'cover-letter', event: 'response' },
      { at: '2026-06-04T00:00:00.000Z', stage: 'cover-letter', event: 'response' },
      { at: '2026-06-08T00:00:00.000Z', stage: 'cover-letter', event: 'response', costUsd: 0.5 },
      { at: '2026-06-11T00:00:00.000Z', stage: 'cover-letter', event: 'response', costUsd: 1.5 },
    ],
  });
  assert.deepEqual(byId(summary)['stage:cover-letter'], {
    id: 'stage:cover-letter',
    calls: 4,
    totalCostUsd: 2,
    windowDays: 10,
    // mean recorded cost 1.0 x 4 calls / 10 days x 365
    annualCostUsd: 146,
    costedCalls: 2,
    estimated: true,
  }, 'two uncosted calls still count, annualized from the mean recorded cost');
});

test('spend report: a response row with a cost is one call', () => {
  const summary = summarizeAiSpend({
    runRows: [
      { at: '2026-04-01T00:00:00.000Z', stage: 'cover-letter', event: 'response', costUsd: 2 },
      { at: '2026-04-01T00:00:00.000Z', stage: 'cover-letter', event: 'response', costUsd: 2 },
    ],
  });
  assert.deepEqual(byId(summary)['stage:cover-letter'], {
    id: 'stage:cover-letter',
    calls: 2,
    totalCostUsd: 4,
    windowDays: 1,
    annualCostUsd: 1460,
    costedCalls: 2,
  }, 'a response row that also carries a cost is counted once, not twice, and is fully costed');
});

test('spend report: a started run row widens the window without counting as a call', () => {
  const summary = summarizeAiSpend({
    runRows: [
      { at: '2026-05-01T00:00:00.000Z', stage: 'cover-letter', event: 'started' },
      { at: '2026-05-03T00:00:00.000Z', stage: 'cover-letter', event: 'thinking-summary' },
      { at: '2026-05-11T00:00:00.000Z', stage: 'cover-letter', event: 'response', costUsd: 1 },
    ],
  });
  assert.deepEqual(byId(summary)['stage:cover-letter'], {
    id: 'stage:cover-letter',
    calls: 1,
    totalCostUsd: 1,
    windowDays: 10,
    annualCostUsd: 36.5,
    costedCalls: 1,
  }, 'the started row spans the 10-day window but is not counted as a call');
});
