import { assert, fetchLinkedInJobs, fetchRemoteOKJobs, formatRemoteOkSalary, linkedInApiRequestPacing, linkedInDescriptionPacing, linkedInPacingWaitMs, linkedInPageStopReason, remoteOkTagsFromQueries, runApiTransportRetry, shouldRetryApiTransportFailure, wwrCategoriesFromQueries } from '../test-dependencies.js';
import {
  tokenizeTargetRole,
  titleMatchesTargetRole,
  titleMatchesTargetRoleTokens,
  filterJobsByTargetRole,
  detectQueryOperators,
} from '../../src/utils/jobTitleMatch.js';

export default [
  {
    name: 'Target-role gate keeps every title containing all typed words in any order or position',
    run: () => {
      const role = 'System Architect';
      const keeps = [
        'System Architect',
        'System Architect II',
        'System and Computer Architect',
        'grocery system Architect',
        'SYSTEM ARCHITECT',
        'Architect, System',                      // reversed order
        'Hybrid Cloud System Architect Senior',
        'System Engineer/Architect (OT/ICS)',     // punctuation is a separator, not part of a word
      ];
      for (const title of keeps) {
        assert(titleMatchesTargetRole(title, role), `"${title}" contains both typed words and must be kept`);
      }
      return { kept: keeps.length };
    },
  },
  {
    name: 'Target-role gate drops titles missing any typed word, including near-miss roles',
    run: () => {
      const role = 'System Architect';
      const drops = [
        'Construction Architect',        // no system*
        'System Engineer',               // no architect*
        'Solution Architect',            // the exact fuzzy match observed on Dice
        'Software Architect',
        'Salesforce Field Service Architect',
        '',                              // no title = no evidence of a match
      ];
      for (const title of drops) {
        assert(!titleMatchesTargetRole(title, role), `"${title}" is missing a typed word and must be dropped`);
      }
      return { dropped: drops.length };
    },
  },
  {
    name: 'Target-role gate absorbs inflection by prefix, one direction only',
    run: () => {
      // Prefix matching exists so the canonical plural title is not lost: on live
      // Dice data 18 of the first 100 on-target titles used "Systems".
      assert(titleMatchesTargetRole('Systems Architect', 'System Architect'), 'system → systems must match');
      assert(titleMatchesTargetRole('Enterprise Systems Architect', 'System Architect'), 'plural with leading words must match');
      assert(titleMatchesTargetRole('Software Systems Architecture', 'System Architect'), 'architect → architecture must match');
      assert(titleMatchesTargetRole('Systems Architects', 'System Architect'), 'both words may inflect at once');

      // The reverse is deliberately NOT true — inflection only lengthens a word,
      // so matching both ways would admit unrelated shorter words.
      assert(!titleMatchesTargetRole('System Architect', 'Systems Architect'), 'typing the plural must not match the singular');
      return { directional: true };
    },
  },
  {
    name: 'Target-role gate requires whole-word equality for words under three characters',
    run: () => {
      // "C++ Developer" tokenizes to ["c", "developer"]; a prefix rule would let
      // "c" match Cloud/Customer/Consulting and quietly restore fuzzy matching.
      assert(titleMatchesTargetRole('Senior C++ Developer', 'C++ Developer'), 'the real C++ role still matches');
      assert(!titleMatchesTargetRole('Cloud Developer', 'C++ Developer'), 'a short token must not prefix-match a longer word');
      assert(!titleMatchesTargetRole('Customer Success Developer', 'C++ Developer'), 'short-token guard holds across candidates');

      assert(titleMatchesTargetRole('IT Support Specialist', 'IT Support'), 'a real two-letter word matches whole');
      assert(!titleMatchesTargetRole('Italian Support Specialist', 'IT Support'), '"IT" must not prefix-match "Italian"');
      return { guarded: true };
    },
  },
  {
    name: 'Target-role tokenizer normalizes case, punctuation, accents and duplicates',
    run: () => {
      assert(JSON.stringify(tokenizeTargetRole('  System   Architect  ')) === JSON.stringify(['system', 'architect']), 'whitespace collapses');
      assert(JSON.stringify(tokenizeTargetRole('Systems, Systems Engineer')) === JSON.stringify(['systems', 'engineer']), 'duplicate words collapse to one requirement');
      assert(JSON.stringify(tokenizeTargetRole('Señior Ingeniero')) === JSON.stringify(['senior', 'ingeniero']), 'accents fold so they compare against folded titles');
      assert(titleMatchesTargetRole('Señior Ingeniero de Datos', 'Senior Ingeniero'), 'accented titles match unaccented input and vice versa');
      return { normalized: true };
    },
  },
  {
    name: 'Target-role gate is a no-op when no role is pinned',
    run: () => {
      // An exploratory (LLM-generated query) run must never be narrowed by this
      // rule — the gate only exists for an explicitly pinned role.
      for (const blank of ['', '   ', null, undefined]) {
        assert(tokenizeTargetRole(blank).length === 0, 'a blank role yields no tokens');
        assert(titleMatchesTargetRoleTokens('literally anything', tokenizeTargetRole(blank)), 'a blank role keeps every job');
      }
      const jobs = [{ title: 'Construction Architect' }, { title: 'Chef' }];
      const result = filterJobsByTargetRole(jobs, '');
      assert(result.jobs === jobs, 'a no-op run returns the input array untouched');
      assert(result.dropped === 0, 'a no-op run drops nothing');
      return { noop: true };
    },
  },
  {
    name: 'Target-role filter reports per-source drops and samples for the run report',
    run: () => {
      const jobs = [
        { title: 'System Architect II', source: 'dice' },
        { title: 'Solution Architect', source: 'dice' },
        { title: 'Systems Architect', source: 'linkedin' },
        { title: 'System Engineer', source: 'linkedin' },
        { title: 'Construction Architect', source: 'glassdoor' },
        { title: '', source: 'remoteok' },
      ];
      const result = filterJobsByTargetRole(jobs, 'System Architect');

      assert(result.jobs.length === 2, 'only the two all-words titles survive');
      assert(result.jobs.every(j => j.title === 'System Architect II' || j.title === 'Systems Architect'), 'survivors are the expected rows');
      assert(result.dropped === 4, 'drop count matches');
      assert(result.droppedBySource.dice === 1 && result.droppedBySource.linkedin === 1, 'per-source accounting is exact');
      assert(result.droppedBySource.glassdoor === 1 && result.droppedBySource.remoteok === 1, 'untitled rows are attributed, not absorbed');
      assert(result.samples.length === 4 && result.samples[0].title === 'Solution Architect', 'samples are verbatim titles for the report');
      assert(JSON.stringify(result.tokens) === JSON.stringify(['system', 'architect']), 'tokens are surfaced for the report line');
      return { kept: result.jobs.length, dropped: result.dropped };
    },
  },
  {
    name: 'Tech vocabulary: symbol-bearing language names stay distinct from each other',
    run: () => {
      // Stripping punctuation would collapse C++, C# and C into one token "c".
      assert(titleMatchesTargetRole('Senior C++ Developer', 'C++ Developer'), 'C++ matches C++');
      assert(!titleMatchesTargetRole('C# Developer', 'C++ Developer'), 'C++ must not match C#');
      assert(!titleMatchesTargetRole('C Developer', 'C++ Developer'), 'C++ must not match plain C');
      assert(!titleMatchesTargetRole('C++ Developer', 'C# Developer'), 'C# must not match C++');
      assert(titleMatchesTargetRole('C# Backend Developer', 'C# Developer'), 'C# matches C#');
      // "cpp" is the same language written without symbols.
      assert(titleMatchesTargetRole('C++ Engineer', 'CPP Engineer'), 'cpp is an alias for C++');
      return { distinct: true };
    },
  },
  {
    name: 'Tech vocabulary: .NET does not prefix-match Network',
    run: () => {
      // ".NET" naively becomes "net", and "net" prefix-matches "network" —
      // a .NET search would return networking roles.
      assert(!titleMatchesTargetRole('Network Developer', '.NET Developer'), '.NET must not match Network');
      assert(!titleMatchesTargetRole('Network Engineer', '.NET Engineer'), '.NET must not match Network Engineer');
      // NOT an identity check — titleMatchesTargetRole(X, X) is true by
      // construction, so it would pass with the whole vocabulary deleted.
      assert(JSON.stringify(tokenizeTargetRole('.NET Developer')) === JSON.stringify(['dotnet', 'developer']),
        '.NET canonicalizes to a token that cannot collide with network*');
      assert(titleMatchesTargetRole('Senior .NET Core Developer', '.NET Developer'), '.NET matches with extra words');
      assert(titleMatchesTargetRole('ASP.NET Developer', '.NET Developer'), 'ASP.NET contains .NET');
      return { collisionRemoved: true };
    },
  },
  {
    name: 'Tech vocabulary: the JS ecosystem is one token however it is spelled',
    run: () => {
      for (const title of ['Node.js Developer', 'NodeJS Developer', 'Node JS Developer', 'Node-js Developer']) {
        assert(titleMatchesTargetRole(title, 'Node.js Developer'), `"${title}" is the same role as Node.js Developer`);
        assert(titleMatchesTargetRole(title, 'NodeJS Developer'), `"${title}" matches when the role is typed NodeJS`);
      }
      assert(titleMatchesTargetRole('React.js Engineer', 'ReactJS Engineer'), 'React.js and ReactJS unify');
      // Only known runtimes/frameworks absorb a trailing "js" — a general rule
      // would fuse unrelated pairs such as "Full Stack JS" into "stackjs".
      assert(!titleMatchesTargetRole('Node Engineer', 'Node.js Engineer'), 'bare "Node" is not "Node.js"');
      return { spellings: 4 };
    },
  },
  {
    name: 'Tech vocabulary: compound role names split and join freely',
    run: () => {
      for (const typed of ['Full Stack Engineer', 'Full-Stack Engineer', 'Fullstack Engineer']) {
        for (const title of ['Full Stack Engineer', 'Full-Stack Engineer', 'Fullstack Engineer']) {
          assert(titleMatchesTargetRole(title, typed), `"${typed}" must match "${title}"`);
        }
      }
      assert(titleMatchesTargetRole('Frontend Developer', 'Front End Developer'), 'front end → frontend');
      assert(titleMatchesTargetRole('Back End Developer', 'Backend Developer'), 'backend → back end');
      // The *Ops family must unify in BOTH directions and reach the spelled-out
      // form. Joining these into one token broke all three: "SecOps" and
      // "Sec Ops" matched neither way, and "ML Ops" could not reach
      // "ML Operations".
      for (const [a, b] of [
        ['DevOps Engineer', 'Dev Ops Engineer'],
        ['SecOps Engineer', 'Sec Ops Engineer'],
        ['FinOps Analyst', 'Fin Ops Analyst'],
        ['MLOps Engineer', 'ML Ops Engineer'],
      ]) {
        assert(titleMatchesTargetRole(a, b), `"${b}" must match "${a}"`);
        assert(titleMatchesTargetRole(b, a), `"${a}" must match "${b}" (the reverse direction too)`);
      }
      assert(titleMatchesTargetRole('ML Operations Engineer', 'ML Ops Engineer'), 'ML Ops reaches ML Operations');
      assert(titleMatchesTargetRole('Development Operations Engineer', 'Dev Ops Engineer'), 'Dev Ops reaches the fully spelled-out form');
      assert(titleMatchesTargetRole('E-Commerce Manager', 'Ecommerce Manager'), 'ecommerce spellings unify');
      // The compound is still a real requirement, not a wildcard.
      assert(!titleMatchesTargetRole('Backend Engineer', 'Full Stack Engineer'), 'fullstack is not backend');
      return { compounds: true };
    },
  },
  {
    name: 'Tech vocabulary: Java must not match JavaScript',
    run: () => {
      // The classic tech-recruiting false positive: prefix matching would make
      // every JavaScript posting a Java hit.
      assert(!titleMatchesTargetRole('JavaScript Developer', 'Java Developer'), 'Java must not match JavaScript');
      assert(!titleMatchesTargetRole('Senior JavaScript Engineer', 'Java Engineer'), 'blocked with extra words');
      assert(JSON.stringify(tokenizeTargetRole('Java Developer')) === JSON.stringify(['java', 'developer']),
        'Java stays its own token');
      // The block is a precise word pair, not a whole-word requirement, so real
      // Java inflections still match.
      assert(titleMatchesTargetRole('JavaEE Developer', 'Java Developer'), 'Java still matches JavaEE');
      assert(titleMatchesTargetRole('Java8 Backend Developer', 'Java Developer'), 'Java still matches Java8');
      return { blocked: 'javascript' };
    },
  },
  {
    name: 'Tech vocabulary: seniority abbreviations unify',
    run: () => {
      assert(titleMatchesTargetRole('Sr. Data Engineer', 'Senior Data Engineer'), 'Sr. matches Senior');
      assert(titleMatchesTargetRole('Sr Data Engineer', 'Senior Data Engineer'), 'Sr matches Senior');
      assert(titleMatchesTargetRole('Senior Data Engineer', 'Sr Data Engineer'), 'Senior matches a typed Sr');
      assert(titleMatchesTargetRole('Jr Software Engineer', 'Junior Software Engineer'), 'Jr matches Junior');
      // Seniority is still a requirement when typed.
      assert(!titleMatchesTargetRole('Data Engineer', 'Senior Data Engineer'), 'an unlevelled title still fails');
      return { abbreviations: true };
    },
  },
  {
    name: 'Tech vocabulary: short tech tokens stay whole-word',
    run: () => {
      assert(titleMatchesTargetRole('Go Backend Engineer', 'Go Engineer'), 'Go matches Go');
      assert(!titleMatchesTargetRole('Google Cloud Engineer', 'Go Engineer'), 'Go must not prefix-match Google');
      assert(titleMatchesTargetRole('AI Research Engineer', 'AI Engineer'), 'AI matches AI');
      assert(!titleMatchesTargetRole('Air Traffic Engineer', 'AI Engineer'), 'AI must not prefix-match Air');
      assert(titleMatchesTargetRole('QA Automation Engineer', 'QA Engineer'), 'QA matches QA');
      // An ampersand name is ONE name. Shredding "M&A" into ["m","a"] made two
      // single-letter tokens, and single letters match whole — so any title
      // containing a stray "A" and "M" satisfied a pinned "M&A Analyst".
      assert(JSON.stringify(tokenizeTargetRole('R&D Engineer')) === JSON.stringify(['rd', 'engineer']),
        'R&D is one token, not two initials');
      assert(titleMatchesTargetRole('Senior M&A Analyst', 'M&A Analyst'), 'a real M&A posting still matches');
      assert(!titleMatchesTargetRole('Senior Analyst, A M Best Company', 'M&A Analyst'),
        'stray initials must NOT satisfy an ampersand name');
      return { shortTokens: true };
    },
  },
  {
    name: 'Tech vocabulary: desirable prefix matches still work',
    run: () => {
      // The vocabulary must not over-correct — these are the inflections the
      // prefix rule exists for.
      assert(titleMatchesTargetRole('Security Operations Engineer', 'Sec Ops Engineer'), 'sec/ops abbreviations expand');
      assert(titleMatchesTargetRole('Testing Engineer', 'Test Engineer'), 'test → testing');
      assert(titleMatchesTargetRole('Developer Advocate', 'Develop Advocate'), 'develop → developer');
      assert(titleMatchesTargetRole('Kubernetes Administrator', 'Kubernetes Admin'), 'admin → administrator');
      return { inflections: true };
    },
  },
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
    name: 'LinkedIn walk: cross-query overlap is not exhaustion',
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

      // Exhaustion outranks the ceiling: an empty page is empty regardless of offset.
      assert(walk(0, 0, 150, 150) === 'exhausted', 'an empty final page reports exhaustion, not a ceiling');
      return { ok: true };
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
  {
    name: 'Target-role gate handles multi-word roles beyond two words',
    run: () => {
      const role = 'Senior Data Engineer';
      assert(titleMatchesTargetRole('Senior Data Engineer', role), 'the plain three-word title matches');
      assert(titleMatchesTargetRole('Senior Staff Data Platform Engineer', role), 'all three words present with gaps');
      assert(titleMatchesTargetRole('Data Engineer, Senior', role), 'order does not matter');
      assert(!titleMatchesTargetRole('Senior Data Scientist', role), 'missing engineer* drops');
      assert(!titleMatchesTargetRole('Data Engineer', role), 'missing senior* drops');
      return { words: 3 };
    },
  },
];
