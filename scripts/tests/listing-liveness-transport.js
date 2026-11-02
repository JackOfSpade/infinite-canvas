import assert from 'node:assert/strict';
import { getKnownTaskIds, taskMaxTokensFor } from '../../electron/ipc/llm.js';
import { WORKER_RAW_RESEARCH_TASKS, WORKER_RELEASE_ONE_TASKS } from '../../electron/ipc/nonApiAi.js';
import { cappedHandoff } from '../../electron/ipc/officialPostingService.js';
import {
  LISTING_LIVENESS_TASK, LISTING_LIVENESS_RESPONSE_SCHEMA, buildListingLivenessRequest,
} from '../../electron/ipc/listingLivenessAi.js';

const member = {
  row: { source: 'ziprecruiter', jobkey: 'synthetic-transport', title: 'Synthetic Engineer', company: 'Example Works', location: 'Remote' },
  evidence: {
    board: 'ziprecruiter', ruleKey: 'ziprecruiter',
    requestedUrl: 'https://www.ziprecruiter.com/jobs/synthetic-transport',
    finalUrl: 'https://www.ziprecruiter.com/jobs/synthetic-transport',
    httpStatus: 200, title: 'Synthetic Engineer | Board', h1: 'Synthetic Engineer',
    expectedTitle: 'Synthetic Engineer', expectedCompany: 'Example Works', expectedLocation: 'Remote',
    redirectedAway: false, titleMatchesPage: true,
    chromeText: 'This posting has closed. This synthetic page is no longer accepting applications.',
    descriptionText: 'Build platform services and document reliable releases.', descriptionIsPage: false,
    closedHits: [{ ruleId: 'synthetic-closed-banner', insideDescription: false, context: 'This posting has closed.' }],
    openSignals: [{ ruleId: 'synthetic-private-open-rule', state: 'active' }],
    jsonLd: { validThrough: null, isListed: null },
  },
};

export default [
  {
    name: 'listing liveness transport: JSON task is registered on release-one and absent from RAW routing',
    run() {
      assert.equal(LISTING_LIVENESS_TASK, 'job-listing-liveness');
      assert.ok(getKnownTaskIds().has(LISTING_LIVENESS_TASK));
      assert.equal(taskMaxTokensFor(LISTING_LIVENESS_TASK, { itemCount: 1 }), 1184);
      assert.equal(taskMaxTokensFor(LISTING_LIVENESS_TASK, { itemCount: 8 }), 2304);
      assert.ok(WORKER_RELEASE_ONE_TASKS.includes(LISTING_LIVENESS_TASK));
      assert.equal(WORKER_RAW_RESEARCH_TASKS.includes(LISTING_LIVENESS_TASK), false);
    },
  },
  {
    name: 'listing liveness transport: one JSON request is sent through the exact response validator',
    async run() {
      const request = buildListingLivenessRequest([member], { batch: 2, batchTotal: 3 });
      assert.equal(request.task, LISTING_LIVENESS_TASK);
      assert.equal(request.format, 'json');
      assert.equal(request.responseSchema, LISTING_LIVENESS_RESPONSE_SCHEMA);
      assert.deepEqual(request.hints, { itemCount: 1, batch: 2, batchTotal: 3 });
      assert.deepEqual(request.manualHandoff, {});
      assert.equal(request.grounding, undefined);
      assert.equal(typeof request.responseValidator, 'function');
      assert.deepEqual(request.responseSchema.required, ['rows']);
      assert.equal(request.responseSchema.additionalProperties, false);
      assert.deepEqual(request.responseSchema.properties.rows.items.required, ['id', 'verdict', 'quote']);
      assert.deepEqual(request.responseSchema.properties.rows.items.properties.verdict.enum, ['open', 'closed', 'unclear']);
      assert.equal(request.responseSchema.properties.rows.items.properties.quote.maxLength, 240);
      assert.match(request.prompt, /<untrusted-job-listing-pages-[a-f0-9]+>/u);
      assert.doesNotMatch(request.prompt, /synthetic-private-open-rule/u, 'open-rule signals are calibration-only');

      const valid = { rows: [{ id: 'r1', verdict: 'closed', quote: 'This posting has closed.' }] };
      let calls = 0;
      const stats = { handoffs: 0, handoffMs: 0 };
      const result = await cappedHandoff(request, {
        call: async (prompt, options) => {
          calls += 1;
          assert.equal(prompt, request.prompt);
          assert.equal(options.task, LISTING_LIVENESS_TASK);
          assert.equal(options.format, 'json');
          assert.equal(options.responseSchema, request.responseSchema);
          assert.deepEqual(options.manualHandoff, {});
          assert.deepEqual(options.hints, request.hints);
          assert.equal(options.nodeId, 'synthetic-node');
          assert.equal(options.manualAiRunId, 'synthetic-run');
          assert.ok(options.signal instanceof AbortSignal);
          assert.throws(() => options.responseValidator({ rows: [
            { id: 'r1', verdict: 'open', quote: 'Build platform services' },
          ] }), error => error.code === 'LISTING_LIVENESS_RESPONSE_INVALID'
            && error.correctionRuleIds?.includes('LIVENESS_QUOTE_IN_DESCRIPTION'));
          return options.responseValidator(valid);
        },
        signal: new AbortController().signal,
        timeoutMs: 1_000,
        manualAiRunId: 'synthetic-run', nodeId: 'synthetic-node',
        hints: request.hints, now: Date.now, stats,
      });
      assert.equal(calls, 1);
      assert.deepEqual(result, valid);
      assert.equal(stats.handoffs, 1);
    },
  },
];
