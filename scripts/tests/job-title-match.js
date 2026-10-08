import { assert, fetchLinkedInJobs, fetchRemoteOKJobs, formatRemoteOkSalary, linkedInApiRequestPacing, linkedInDescriptionPacing, linkedInPacingWaitMs, linkedInPageStopReason, remoteOkTagsFromQueries, runApiTransportRetry, shouldRetryApiTransportFailure, wwrCategoriesFromQueries } from '../test-dependencies.js';
import { fetchUSAJobs } from '../../electron/extractors/apiExtractors.js';
import { detectQueryOperators } from '../../src/utils/jobTitleMatch.js';

export default [
  {
    name: 'Operator advisory detects Boolean syntax typed into the role box',
    run: () => {
      // Broadcast operators are unsafe: ignored on three boards, destructive on
      // Google/USAJobs, and intent-inverting on ZipRecruiter.
      assert(detectQueryOperators('Controller NOT carpenter').includes('NOT'), 'NOT is detected');
      assert(detectQueryOperators('Engineer -manager').includes('-term'), 'leading minus is detected');
      assert(detectQueryOperators('Nurse OR Physician').includes('OR'), 'OR is detected');
      assert(detectQueryOperators('title:"System Architect"').includes('field:'), 'field syntax is detected');
      assert(detectQueryOperators('"System Architect"').includes('"quotes"'), 'quotes are detected');
      // Ordinary roles must not trip the advisory, including hyphenated ones.
      for (const clean of ['System Architect', 'Full-Stack Engineer', 'Sr. Data Engineer', 'C++ Developer', 'R&D Manager']) {
        assert(detectQueryOperators(clean).length === 0, `"${clean}" is not operator syntax`);
      }
      return { detected: true };
    },
  },
  {
    name: 'LinkedIn walk: cross-query overlap is not exhaustion or a fixed 150-result ceiling',
    run: () => {
      const walk = (cardsOnPage, newToThisQuery, nextStart = 50, maxResults = 150) =>
        linkedInPageStopReason({ cardsOnPage, newToThisQuery, nextStart, maxResults });

      // THE BUG: freshness was measured against the run-wide dedup set, so a page
      // whose rows an EARLIER query had already returned looked identical to
      // exhaustion and ended this query's walk on page 1. The generator emits
      // several near-synonym queries, so that overlap is the expected case.
      assert(walk(25, 25) === null, 'a full page of new rows keeps walking');
      assert(walk(25, 25, 25, 150) === null, 'still walking well inside the offset budget');

      // Genuine stops remain distinguishable from each other.
      assert(walk(0, 0) === 'exhausted', 'no cards at all is real exhaustion');
      assert(walk(25, 0) === 'no-new-rows', 'cards present but none new to THIS query = pager not advancing');
      assert(walk(25, 25, 150, 150) === 'result-ceiling', 'the offset budget bound the walk, not the data');
      assert(walk(25, 25, 175, 150) === 'result-ceiling', 'past the budget is still ceiling-bound');

      // Current collection is no longer capped at LinkedIn's historical
      // 150-offset budget. An actual empty/repeated/no-progress page remains
      // the only stop signal for an otherwise productive long walk.
      assert(walk(25, 25, 175, Infinity) === null,
        'a productive page beyond 150 results remains eligible for collection');
      assert(linkedInPageStopReason({ cardsOnPage: 25, newToThisQuery: 25, unproductiveStreak: 2, nextStart: 175, maxResults: Infinity }) === 'redundant-query',
        'a no-output pager still halts after its explicit no-progress streak without restoring a total result cap');

      // Exhaustion outranks the ceiling: an empty page is empty regardless of offset.
      assert(walk(0, 0, 150, 150) === 'exhausted', 'an empty final page reports exhaustion, not a ceiling');
      return { uncappedBeyond150: true, noProgressStopped: true };
    },
  },
  {
    name: 'USAJobs walks page 11 and stops only on provider totals, short pages, or a repeated page',
    run: async () => {
      const nativeFetch = globalThis.fetch;
      const pageSize = 500;
      const row = id => ({ MatchedObjectId: `position-${id}`, MatchedObjectDescriptor: { PositionID: `position-${id}`, PositionTitle: `Engineer ${id}`, OrganizationName: 'Agency', PositionLocationDisplay: 'Remote', PositionURI: `https://www.usajobs.gov/job/${id}` } });
      const responseFor = (items, total) => new Response(JSON.stringify({ SearchResult: { SearchResultCountAll: total, SearchResultItems: items } }), { status: 200, headers: { 'content-type': 'application/json' } });
      try {
        let calls = 0;
        globalThis.fetch = async (url) => {
          calls += 1;
          const page = Number(new URL(url).searchParams.get('Page'));
          const count = page === 11 ? 1 : pageSize;
          const start = (page - 1) * pageSize;
          return responseFor(Array.from({ length: count }, (_unused, index) => row(start + index)), 5_001);
        };
        const pageEleven = await fetchUSAJobs('engineer', 'test-key', 'test@example.com', null, 30, '', Infinity);
        assert(calls === 11 && pageEleven.items.length === 5_001 && pageEleven.providerTotal === 5_001 && !pageEleven.truncated,
          'a provider total beyond ten 500-row pages reaches page 11 and retains every mapped result');

        calls = 0;
        const repeated = Array.from({ length: pageSize }, (_unused, index) => row(index));
        globalThis.fetch = async () => {
          calls += 1;
          return responseFor(repeated, 2_000);
        };
        const stalled = await fetchUSAJobs('engineer', 'test-key', 'test@example.com', null, 30, '', Infinity);
        assert(calls === 2 && stalled.truncated && stalled.warning?.code === 'provider-pagination-stalled' && stalled.items.length === pageSize,
          'a repeated provider page stops the walk as partial rather than treating a no-progress pager as permission for unbounded requests');
        return { pageElevenCalls: 11, repeatedPageCalls: calls };
      } finally {
        globalThis.fetch = nativeFetch;
      }
    },
  },
  {
    name: 'LinkedIn guest search requests use one local cadence across query modules',
    run: () => {
      const first = linkedInApiRequestPacing({ requestsIssued: 0 });
      const second = linkedInApiRequestPacing({ requestsIssued: 1 });
      const fourth = linkedInApiRequestPacing({ requestsIssued: 3 });
      assert(!first.delayDue && !first.checkpointDue,
        'the first LinkedIn search request has no prior provider request to delay');
      assert(second.delayDue && second.requestDelayMs === 6000 && !second.checkpointDue,
        'every subsequent request, including a next query module page 0, has the same minimum gap');
      assert(fourth.delayDue && fourth.checkpointDue && fourth.checkpointEvery === 3
        && fourth.checkpointCooldownMs === 20000,
      'before each fourth guest-search request, drain the rolling window without retrying a 429');
      assert(linkedInPacingWaitMs(second) === 6000
        && linkedInPacingWaitMs(fourth) === 20000
        && linkedInPacingWaitMs({ requestDelayMs: 6000, checkpointDue: true, checkpointCooldownMs: 1000 }) === 6000,
      'the actual pre-dispatch wait is one long checkpoint when it covers the ordinary gap, while a future short checkpoint still preserves the normal minimum');
      return { gapMs: second.requestDelayMs, checkpointMs: fourth.checkpointCooldownMs, checkpointWaitMs: linkedInPacingWaitMs(fourth) };
    },
  },
  {
    name: 'LinkedIn description requests use provider-local gaps and guest rolling-window pauses',
    run: () => {
      const guestBeforeCheckpoint = linkedInDescriptionPacing({ mode: 'guest', requestsIssued: 2 });
      const guestCheckpoint = linkedInDescriptionPacing({ mode: 'guest', requestsIssued: 3 });
      const authenticated = linkedInDescriptionPacing({ mode: 'authenticated', requestsIssued: 3 });
      assert(guestBeforeCheckpoint.requestDelayMs === 2500 && !guestBeforeCheckpoint.checkpointDue,
        'every LinkedIn detail navigation must have a minimum human-scale gap');
      assert(guestCheckpoint.checkpointDue && guestCheckpoint.checkpointEvery === 3
        && guestCheckpoint.checkpointCooldownMs === 15000,
      'the guest SEO path must pause after each small burst before LinkedIn reaches its observed 3–4 request wall');
      assert(!authenticated.checkpointDue && authenticated.checkpointEvery === null,
        'an authenticated detail walk keeps the per-request floor without guest-session checkpoints');
      const afterThreeDispatched = linkedInDescriptionPacing({ mode: 'guest', requestsIssued: 3 });
      assert(afterThreeDispatched.checkpointDue,
        'the checkpoint input is dispatched requests, so failed/walling navigations cannot evade the next guest pause');
      assert(linkedInPacingWaitMs(guestBeforeCheckpoint) === 2500
        && linkedInPacingWaitMs(guestCheckpoint) === 15000
        && linkedInPacingWaitMs({ requestDelayMs: 2500, checkpointDue: true, checkpointCooldownMs: 500 }) === 2500,
      'detail navigation makes one abortable pre-dispatch wait: the guest checkpoint substitutes for, rather than stacks with, its ordinary gap');
      return { gapMs: guestCheckpoint.requestDelayMs, checkpointMs: guestCheckpoint.checkpointCooldownMs, checkpointWaitMs: linkedInPacingWaitMs(guestCheckpoint) };
    },
  },
  {
    name: 'RemoteOK tag fan-out is derived, deduped and bounded',
    run: () => {
      // The bare feed is capped at roughly 100 postings (limit/offset are ignored), and a
      // tag-scoped fetch returns DIFFERENT inventory — measured live, ?tag=react
      // returned 100 postings with ZERO overlap with the bare feed. Tags are the
      // only way to reach the rest, so they are derived from the run's queries.
      assert(JSON.stringify(remoteOkTagsFromQueries(['System Architect'])) === JSON.stringify(['system', 'architect']),
        'query words become candidate tags in order');
      assert(remoteOkTagsFromQueries(['alpha beta gamma delta epsilon']).length === 3,
        'the request count is capped regardless of query length (RemoteOK ToS threatens suspension for misuse)');
      assert(remoteOkTagsFromQueries(['senior remote jobs']).length === 0,
        'stopwords that would match half the feed are excluded');
      assert(remoteOkTagsFromQueries(['React react REACT']).length === 1,
        'case-insensitive dedup — never two requests for the same tag');
      for (const empty of [[], null, undefined, [''], ['  ']]) {
        assert(remoteOkTagsFromQueries(empty).length === 0, 'no queries means no extra requests');
      }
      // A wrong guess is harmless by construction: an unknown tag returns the
      // metadata element only, which is zero rows after the slice(1).
      assert(remoteOkTagsFromQueries(['zzqxnotatag']).length === 1, 'an unknown word is still attempted — a miss costs one empty response, not an error');
      return { ok: true };
    },
  },
  {
    name: 'RemoteOK retries only transient transport failures and never provider throttles or cancellation',
    run: async () => {
      const transportFailure = {
        ok: false,
        status: 0,
        warning: { code: 'api-fetch-failed' },
      };
      assert(shouldRetryApiTransportFailure(transportFailure, null, 0, 1),
        'the first network/timeout failure is eligible for one bounded retry');
      assert(!shouldRetryApiTransportFailure(transportFailure, null, 1, 1),
        'a persistent transport failure stops after the configured retry ceiling');
      assert(!shouldRetryApiTransportFailure({ ok: false, status: 429, warning: { code: 'http-429' } }, null, 0, 1),
        'HTTP 429 is a provider throttle and must not be retried immediately');
      assert(!shouldRetryApiTransportFailure({ ok: false, status: 403, warning: { code: 'http-403' } }, null, 0, 1),
        'HTTP 403 is a provider response and must not be retried immediately');
      assert(!shouldRetryApiTransportFailure(transportFailure, { aborted: true }, 0, 1),
        'user cancellation must suppress a retry');

      let calls = 0;
      const waits = [];
      const recovered = await runApiTransportRetry(async () => {
        calls++;
        return calls === 1 ? transportFailure : { ok: true, status: 200 };
      }, {
        maxRetries: 1,
        retryDelayMs: 2000,
        jitter: ms => ms,
        sleep: async ms => { waits.push(ms); },
      });
      assert(recovered.ok && calls === 2 && waits.length === 1 && waits[0] === 2000,
        'a transient transport failure must execute exactly one delayed retry and return its recovery');

      calls = 0;
      const cancellation = { aborted: false };
      const cancelled = await runApiTransportRetry(async () => {
        calls++;
        return transportFailure;
      }, {
        signal: cancellation,
        maxRetries: 1,
        retryDelayMs: 2000,
        jitter: ms => ms,
        sleep: async () => { cancellation.aborted = true; },
      });
      assert(!cancelled.ok && cancelled.aborted && cancelled.warning === null && calls === 1,
        'cancellation during retry backoff must prevent the second request and suppress a false transport warning');

      calls = 0;
      const capped = await runApiTransportRetry(async () => {
        calls++;
        return transportFailure;
      }, {
        maxRetries: Infinity,
        retryDelayMs: 0,
        jitter: ms => ms,
        sleep: async () => {},
      });
      assert(!capped.ok && calls === 1,
        'a non-finite generic retry setting must not turn a persistent failure into an infinite loop');

      calls = 0;
      await runApiTransportRetry(async () => {
        calls++;
        return transportFailure;
      }, {
        maxRetries: 1_000_000,
        retryDelayMs: 0,
        jitter: ms => ms,
        sleep: async () => {},
      });
      assert(calls === 6,
        'a huge generic retry setting must stop at the five-retry safety ceiling');
      return { maxRetries: 1, recoveredCalls: 2, cancelledCalls: calls };
    },
  },
  {
    name: 'RemoteOK public fetch retries only transports and preserves partial base results safely',
    run: async () => {
      const nativeFetch = globalThis.fetch;
      const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status });
      try {
        let calls = 0;
        globalThis.fetch = async () => {
          calls++;
          throw new TypeError('socket dropped');
        };
        const persistentTransport = await fetchRemoteOKJobs(['engineer']);
        assert(calls === 2 && persistentTransport.items.length === 0
          && persistentTransport.warning?.code === 'api-fetch-failed',
        'a persistent RemoteOK transport failure retries exactly once and remains visible');

        calls = 0;
        const cancelledController = new AbortController();
        cancelledController.abort();
        globalThis.fetch = async () => { calls++; throw new Error('must not fetch after cancellation'); };
        const cancelledRemote = await fetchRemoteOKJobs(['engineer'], cancelledController.signal);
        const cancelledLinkedIn = await fetchLinkedInJobs(['engineer'], cancelledController.signal);
        assert(calls === 0 && cancelledRemote.cancelled && cancelledRemote.warning === null
          && cancelledLinkedIn.cancelled && cancelledLinkedIn.warning === null,
        'cancelled HTTP extractors return silent envelopes before dispatch, so downstream progress/staging can ignore them');

        calls = 0;
        globalThis.fetch = async () => {
          calls++;
          return new Response('', { status: 429 });
        };
        const throttled = await fetchRemoteOKJobs(['engineer']);
        assert(calls === 1 && throttled.warning?.code === 'http-429',
          'an HTTP 429 is terminal and must not be retried');

        calls = 0;
        globalThis.fetch = async () => {
          calls++;
          return jsonResponse({ maintenance: true });
        };
        const malformed = await fetchRemoteOKJobs(['engineer']);
        assert(calls === 1 && malformed.warning?.code === 'remoteok-malformed-response',
          'a 200 non-array payload is a visible malformed-provider failure, not a successful zero');

        calls = 0;
        globalThis.fetch = async () => {
          calls++;
          if (calls === 1) {
            return jsonResponse([{ legal: 'metadata' }, {
              id: 'base-1', position: 'Platform Engineer', company: 'Acme', url: '/remote-jobs/base-1', tags: ['platform'],
            }]);
          }
          return new Response('', { status: 429 });
        };
        const partial = await fetchRemoteOKJobs(['platform engineer']);
        assert(calls === 2 && partial.items.length === 1 && partial.warning?.code === 'http-429'
          && partial.remoteFeedProvenance?.length === 2 && partial.remoteFeedProvenance[1]?.fanoutStopped,
        'a failed optional tag feed preserves base jobs and stops all later tag requests');
        return { transportCalls: 2, throttleCalls: 1, partialCalls: calls };
      } finally {
        globalThis.fetch = nativeFetch;
      }
    },
  },
  {
    name: 'WeWorkRemotely category fan-out is query-derived and bounded',
    run: () => {
      // The main feed has no keyword parameter (?search= is a verified no-op) and
      // caps around 90 postings. Category feeds carry different inventory —
      // measured live, three of them held 78 postings the main feed did not list.
      assert(wwrCategoriesFromQueries(['System Architect']).includes('remote-programming-jobs'),
        'an engineering role implies the programming feed');
      assert(wwrCategoriesFromQueries(['Senior UX Designer']).includes('remote-design-jobs'),
        'a design role implies the design feed');
      assert(!wwrCategoriesFromQueries(['Senior UX Designer']).includes('remote-programming-jobs'),
        'an unrelated taxonomy branch is not pulled just to be discarded by the title gate');
      assert(wwrCategoriesFromQueries(['engineer devops design product support']).length === 3,
        'the extra request count is capped (WWR rate-limits and 403s on excess)');
      for (const empty of [[], null, undefined, [''], ['   ']]) {
        assert(wwrCategoriesFromQueries(empty).length === 0, 'no queries means no extra requests');
      }
      return { ok: true };
    },
  },
  {
    name: 'RemoteOK salary never emits a half-formed range',
    run: () => {
      // The feed uses 0 (not null) for "no figure", and only salary_min used to
      // be guarded — so a min-only posting rendered "$120000 - $undefined" on the
      // card and in the scoring prompt, and a max-only posting reported nothing
      // at all (bucketed Unspecified, excluded from the 75+ compensation gate).
      assert(formatRemoteOkSalary(120000, 160000) === '$120,000 - $160,000', 'a real range formats both bounds');
      assert(formatRemoteOkSalary(120000, 0) === '$120,000', 'min-only yields a single figure, never "$X - $undefined"');
      assert(formatRemoteOkSalary(0, 160000) === '$160,000', 'max-only is no longer dropped');
      assert(formatRemoteOkSalary(120000, undefined) === '$120,000', 'a missing max is not interpolated');
      assert(formatRemoteOkSalary(150000, 150000) === '$150,000', 'a degenerate range collapses to one figure');
      assert(formatRemoteOkSalary(0, 0) === '', 'no figures yields an empty string');
      assert(formatRemoteOkSalary(null, null) === '', 'nulls yield an empty string');
      for (const out of [formatRemoteOkSalary(1, undefined), formatRemoteOkSalary(undefined, 1), formatRemoteOkSalary('x', 'y')]) {
        assert(!/undefined|NaN/.test(out), `"${out}" must never contain undefined or NaN`);
      }
      return { ok: true };
    },
  },
];
