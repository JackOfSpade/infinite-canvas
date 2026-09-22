// Regression coverage for the Search-Brief role-lock design, now SINGLE MODE:
// the AI always determines `preferencePlan.titles` (even when the brief
// names explicit titles), `titleSource` is deleted everywhere, and the old
// deterministic post-search title gate is replaced by a separate title-only
// AI role screen (screenJobRolesByTitle) that FAILS OPEN. See the project
// handoff notes for the full migration; the tests below guard the RISKS the
// old two-mode design also guarded against, just against their new shape:
// a role-determination handoff silently hard-dropping good jobs, a
// user-written title silently vanishing from the locked role list, a lock
// sentinel that cannot tell "resolved to zero roles" from "never resolved",
// and a paid-for AI handoff being silently discarded or silently skipped.
// Where the underlying logic is a small pure function embedded in a renderer
// component (JobSearchNode.jsx / JobBoardNode.jsx / JobSearchDoneState.jsx
// are not import-able modules -- they are React components with side
// effects), the exact function (or, for one single-line sentinel, the exact
// line) source is extracted from the file and executed via `new Function` --
// the same technique already used by scripts/tests/solve-ipc-failure.js and
// platform-utils.js -- so these tests exercise the REAL current behavior,
// not a paraphrase of it in prose.
import { assert, fs, mergeNonRestorableNodeDataFromLive, normalizeJobPreferencePlan, redactReportEventHistoryLine, resolveSearchRoles, sanitizeJobPreferencePlan, screenJobRolesByTitle } from '../test-dependencies.js';

// Shared minimal-but-schema-valid raw plan builder -- mirrors the `rawPlan`
// helper already used by the resolveSearchRoles tests in job-run-staging.js,
// so a fixture built here is guaranteed to satisfy hasValidRawPlanShape.
// SINGLE MODE: no more `titleSource` parameter -- that discriminator is
// deleted from the plan shape entirely (see JOB_PREFERENCE_PLAN_SCHEMA /
// normalizeJobPreferencePlan in aiSchemas.js / jobPreferences.js).
function rawPlan(titles) {
  return {
    version: 1,
    summary: '',
    direction: { summary: '', roleDirections: [], avoidDirections: [], explorationEnabled: false },
    softPreferences: [],
    strictRequirements: [],
    warnings: [],
    titles,
  };
}

// Extracts a top-level `function NAME(...) { ... }` declaration's exact
// source text out of a file, from its `function` keyword through the first
// line that is exactly `}` after it. Every function extracted below has no
// nested top-level block (no inner `if { ... }` whose own close brace could
// be mistaken for the function's), verified by eye against the current
// source, so this simple scan is exact rather than a brace-counting parser.
function extractFunction(source, signature, label) {
  const start = source.indexOf(signature);
  const end = source.indexOf('\n}', start);
  assert(start >= 0 && end > start, `${label}: could not locate "${signature}" as a verbatim function declaration -- has it been renamed or restructured?`);
  return source.slice(start, end + 2);
}

// Extracts one exact source LINE (from a verbatim leading substring through
// the next newline). Used for JobSearchDoneState.jsx's `settingsFrozen`
// sentinel, which is a single `const` assignment inside a component body,
// not a standalone function declaration -- extractFunction's brace-scan
// doesn't apply, but the same falsifiability goal does: if the real line is
// ever renamed/restructured (e.g. reverted to keying on `resolvedRoles.length`
// instead of `resolvedRolesMeta`), the literal signature below will no
// longer be found and this test fails loudly instead of silently testing a
// stale paraphrase.
function extractLine(source, signature, label) {
  const start = source.indexOf(signature);
  assert(start >= 0, `${label}: could not locate "${signature}" as a verbatim line -- has it been renamed or restructured?`);
  const end = source.indexOf('\n', start);
  return source.slice(start, end >= 0 ? end : source.length);
}

export default [
  {
    // FIX1 successor: the old deterministic post-search title gate
    // (deriveGatePinnedTitles, titleSource-aware) is gone entirely. It is
    // replaced by screenJobRolesByTitle, a SEPARATE title-only AI call that
    // sits where the old gate sat. The risk the old gate's titleSource split
    // guarded against -- an AI-driven role decision silently hard-dropping
    // good jobs -- is now guarded by this screen's FAIL-OPEN contract:
    // 'unclear', a missing verdict, and a malformed/unknown outcome string
    // must all KEEP the job; only an explicit 'mismatch' may drop one. Also
    // asserts the cost guarantee (zero AI calls for an empty title list or an
    // empty pool) and the no-mutation contract (matching attachAssessments'
    // own spread-not-mutate convention).
    name: 'REGRESSION FIX1: screenJobRolesByTitle fails OPEN -- only an explicit "mismatch" verdict drops a job; unclear/missing/malformed all keep it',
    run: async () => {
      const jobs = [
        { title: 'Product Manager', company: 'Acme' }, // match
        { title: 'Warehouse Associate', company: 'Acme' }, // mismatch -> dropped
        { title: 'Senior Product Manager', company: 'Acme' }, // unclear -> kept
        { title: 'Product Lead', company: 'Acme' }, // MISSING verdict entirely -> kept
        { title: 'Product Owner', company: 'Acme' }, // malformed/unknown outcome string -> kept
      ];
      Object.freeze(jobs);
      jobs.forEach(job => Object.freeze(job));

      const result = await screenJobRolesByTitle({
        jobs, titles: ['Product Manager'],
        callText: async (_prompt, options) => {
          assert(options.task === 'job-role-screen-batch', `expected task 'job-role-screen-batch', got '${options.task}'`);
          return {
            verdicts: [
              { index: 0, outcome: 'match', reason: '' },
              { index: 1, outcome: 'mismatch', reason: 'warehouse role' },
              { index: 2, outcome: 'unclear', reason: '' },
              // index 3: no verdict returned for this index at all.
              { index: 4, outcome: 'not-a-real-outcome', reason: 'gibberish' },
            ],
          };
        },
      });

      const acceptedTitles = result.acceptedJobs.map(j => j.title).sort();
      const expectedAccepted = ['Product Lead', 'Product Manager', 'Product Owner', 'Senior Product Manager'].sort();
      assert(JSON.stringify(acceptedTitles) === JSON.stringify(expectedAccepted),
        `fail-open contract violated -- expected ${JSON.stringify(expectedAccepted)}, got ${JSON.stringify(acceptedTitles)}`);
      assert(result.droppedJobs.length === 1 && result.droppedJobs[0].title === 'Warehouse Associate',
        'only the explicit mismatch verdict may drop a job');
      assert(result.counts.dropped === 1 && result.counts.accepted === 4 && result.counts.unclear === 3,
        `counts must reflect fail-open (real unclear + missing-verdict + malformed-outcome all count as unclear), got ${JSON.stringify(result.counts)}`);
      assert(!result.acceptedJobs.some(j => j.roleScreen.reason), 'a kept job must never carry a mismatch reason');
      assert(result.droppedJobs[0].roleScreen.reason === 'warehouse role', 'a dropped job must carry its mismatch reason');

      // No-mutation contract: the frozen input objects must be untouched --
      // every returned job (accepted or dropped) must be a NEW object.
      assert(jobs.every(job => !('roleScreen' in job)), 'screenJobRolesByTitle must never mutate the input job objects');

      // Cost guarantee: zero AI calls when there is nothing legitimate to
      // screen (see the function's own comment -- a non-empty brief always
      // resolves to at least one title, so an empty `titles` here means the
      // brief itself was empty, and rubber-stamping that must never cost a
      // handoff).
      const throwingCallText = async () => { throw new Error('must not be called'); };
      const emptyTitlesResult = await screenJobRolesByTitle({ jobs, titles: [], callText: throwingCallText });
      assert(emptyTitlesResult.acceptedJobs.length === jobs.length && emptyTitlesResult.droppedJobs.length === 0,
        'an empty titles list must accept every job with zero AI calls');
      const emptyPoolResult = await screenJobRolesByTitle({ jobs: [], titles: ['Product Manager'], callText: throwingCallText });
      assert(emptyPoolResult.acceptedJobs.length === 0 && emptyPoolResult.droppedJobs.length === 0,
        'an empty job pool must short-circuit with zero AI calls');

      const packedJobs = Array.from({ length: 597 }, (_, index) => ({ title: `Product Manager ${index}`, company: 'Acme' }));
      const packedHints = [];
      let activeBatches = 0;
      let peakBatches = 0;
      const packed = await screenJobRolesByTitle({
        jobs: packedJobs,
        titles: ['Product Manager'],
        callText: async (_prompt, options) => {
          packedHints.push({ task: options.task, ...options.hints });
          activeBatches += 1;
          peakBatches = Math.max(peakBatches, activeBatches);
          await new Promise(resolve => setTimeout(resolve, options.hints.batch === 1 ? 5 : 0));
          activeBatches -= 1;
          return { verdicts: Array.from({ length: options.hints.itemCount }, (_, index) => ({ index, outcome: 'match', reason: '' })) };
        },
      });
      assert(peakBatches === 3
        && packed.acceptedJobs.length === 597
        && JSON.stringify(packedHints.map(hint => [hint.task, hint.batch, hint.batchTotal, hint.itemCount]))
          === JSON.stringify([
            ['job-role-screen-batch', 1, 3, 298],
            ['job-role-screen-batch', 2, 3, 298],
            ['job-role-screen-batch', 3, 3, 1],
          ]),
      'fresh role screening fills the 15,360-token budget with 298 rows and dispatches independent batches together');

      const legacyTasks = [];
      await screenJobRolesByTitle({
        jobs,
        titles: ['Product Manager'],
        useLegacyRoleScreen: true,
        callText: async (_prompt, options) => {
          legacyTasks.push(options.task);
          return { verdicts: [] };
        },
      });
      assert(JSON.stringify(legacyTasks) === JSON.stringify(['job-role-screen']),
        'an in-progress legacy run retains its original role-screen task contract');

      return { failOpenRespected: true, noMutation: true, zeroCallsWhenEmpty: true, packedBatches: packedHints.length };
    },
  },
  {
    name: 'REGRESSION: a resumed role screen replays only exact v1 chunks and packs untouched rows into v2 batches without duplicates or gaps',
    run: async () => {
      const jobs = Array.from({ length: 500 }, (_, index) => ({ title: `Product Manager ${index}`, company: 'Acme' }));
      const probes = [];
      const calls = [];
      const result = await screenJobRolesByTitle({
        jobs,
        titles: ['Product Manager'],
        // v1 split the original pool at 0..199, 200..399, 400..499. Only
        // the first is already durable; later chunks must not be held hostage
        // by that fact and must use today's 298-row packed layout.
        legacyRoleScreenStepProbe: async ({ prompt, task, responseSchema, hints }) => {
          probes.push({ prompt, task, responseSchema, hints });
          return probes.length === 1;
        },
        callText: async (_prompt, options) => {
          calls.push({ task: options.task, hints: options.hints });
          return { verdicts: Array.from({ length: options.hints.itemCount }, (_, index) => ({ index, outcome: 'match', reason: '' })) };
        },
      });
      assert(JSON.stringify(probes.map(probe => [probe.task, probe.hints.itemCount])) === JSON.stringify([
        ['job-role-screen', 200], ['job-role-screen', 200], ['job-role-screen', 100],
      ]), 'the exact-step probe must reconstruct every original fixed v1 chunk before choosing a contract');
      assert(JSON.stringify(calls.map(call => [call.task, call.hints.batch || null, call.hints.batchTotal || null, call.hints.itemCount])) === JSON.stringify([
        ['job-role-screen', null, null, 200],
        ['job-role-screen-batch', 1, 2, 298],
        ['job-role-screen-batch', 2, 2, 2],
      ]), 'only the durable v1 prompt may replay; all untouched rows must enter deterministic 298-row v2 batches');
      assert(result.acceptedJobs.length === jobs.length
        && new Set(result.acceptedJobs.map(job => job.title)).size === jobs.length,
      'hybrid replay must preserve every original row exactly once');
      return { probes: probes.length, calls: calls.length, accepted: result.acceptedJobs.length };
    },
  },
  {
    // ADVERSARIAL-REVIEW FIX (bulk role screen dup-index handling):
    // screenJobRolesByTitle used to build its per-batch verdict map with
    // `new Map(pairs)`, which keeps the LAST entry for a repeated key. A
    // garbled/duplicated paste carrying two verdicts for the same index could
    // therefore let a later spurious 'mismatch' silently overrule an earlier
    // 'match' -- array order, not the model's actual judgment, decided
    // whether the job survived. The fix builds the map by hand: a
    // CONTRADICTORY duplicate (the two verdicts disagree on outcome)
    // collapses to 'unclear', matching this screen's own fail-open contract
    // (see the FIX1 test above). An AGREEING duplicate (both copies name the
    // same outcome) must still apply exactly as if sent once -- the fix must
    // not turn every repeated index into a free pass for a genuinely
    // mismatched job.
    name: 'REGRESSION (bulk role screen dup-index handling): a CONTRADICTORY duplicate verdict for one index collapses to unclear (kept); an AGREEING duplicate still applies normally',
    run: async () => {
      const jobs = [
        { title: 'Product Manager', company: 'Acme' }, // index 0: contradictory duplicate (match then mismatch)
        { title: 'Warehouse Associate', company: 'Acme' }, // index 1: agreeing duplicate (mismatch, mismatch)
      ];
      const result = await screenJobRolesByTitle({
        jobs, titles: ['Product Manager'],
        callText: async () => ({
          verdicts: [
            { index: 0, outcome: 'match', reason: '' },
            { index: 0, outcome: 'mismatch', reason: 'a later spurious verdict' },
            { index: 1, outcome: 'mismatch', reason: 'warehouse role' },
            { index: 1, outcome: 'mismatch', reason: 'warehouse role, restated' },
          ],
        }),
      });

      const byTitle = title => [...result.acceptedJobs, ...result.droppedJobs].find(j => j.title === title);
      assert(byTitle('Product Manager').roleScreen.outcome === 'unclear',
        `a CONTRADICTORY duplicate verdict for the same index must collapse to 'unclear' rather than let the later 'mismatch' silently overrule the earlier 'match', got ${byTitle('Product Manager').roleScreen.outcome}`);
      assert(result.acceptedJobs.some(j => j.title === 'Product Manager'),
        'a contradictory duplicate must resolve to KEPT (unclear is fail-open), not dropped -- old last-wins behavior dropped this job');

      assert(byTitle('Warehouse Associate').roleScreen.outcome === 'mismatch',
        `an AGREEING duplicate verdict (both copies name the same outcome) must still apply normally, got ${byTitle('Warehouse Associate').roleScreen.outcome}`);
      assert(result.droppedJobs.some(j => j.title === 'Warehouse Associate'),
        'an agreeing duplicate mismatch must still drop the job -- the dup-index fix must not turn every repeated index into a free pass');

      return { contradictoryCollapsesToUnclear: true, agreeingDuplicateStillApplies: true };
    },
  },
  {
    // ADVERSARIAL-REVIEW FIX (MAX_TITLES truncation vs. restored user
    // titles): resolveSearchRoles's repair (see the FIX6 test below) puts a
    // silently-dropped user-authored title back into the final `titles`
    // list. But restoration alone is not enough -- every downstream
    // normalizer caps that list at MAX_TITLES (20) and truncates from the
    // END. Appending the restored titles (the old order) meant the cap could
    // still evict exactly the titles the repair just restored, the moment
    // pass 2's own coverage additions pushed the combined list past 20. The
    // fix orders the user's own titles FIRST, so truncation can only ever
    // evict a MODEL addition. This exercises that with a pass-2 audit that
    // returns a full 20-title list of its own coverage additions -- none of
    // them overlapping the user's 3 -- while silently (not-declared-removed)
    // dropping all 3 user titles from its own `titles` array.
    name: 'REGRESSION (MAX_TITLES=20 truncation, bug #3): user-authored titles are ordered FIRST so a 20-title coverage audit cannot silently evict them via the cap; they survive a normalizeJobPreferencePlan round-trip too',
    run: async () => {
      const userTitles = ['Data Analyst', 'Business Analyst', 'Financial Analyst'];
      const brief = `Looking for ${userTitles[0]}, ${userTitles[1]}, or ${userTitles[2]} roles, ideally hybrid.`;
      const coverageAdditions = Array.from({ length: 20 }, (_, i) => `Coverage Role ${i + 1}`);

      const { plan } = await resolveSearchRoles({
        jobPreferences: brief,
        profile: {}, careerData: '',
        callText: async (_prompt, options) => {
          if (options.task === 'job-preference-interpretation') return rawPlan(userTitles);
          if (options.task === 'job-role-audit') {
            return {
              // A full 20-title audit response, none of which are the user's
              // own titles, and none of the user's titles declared in
              // `removed` -- a SILENT drop, exactly what FIX6's deterministic
              // repair restores.
              titles: coverageAdditions,
              added: coverageAdditions, addedReason: 'broader coverage',
              removed: [], removedReason: '',
              rationale: 'test fixture',
            };
          }
          throw new Error(`unexpected task '${options.task}'`);
        },
      });

      assert(plan.titles.length <= 20, `plan.titles must respect MAX_TITLES=20, got ${plan.titles.length}`);
      for (const title of userTitles) {
        assert(plan.titles.includes(title),
          `a 20-title coverage audit must not be able to silently evict a user-authored title via the cap -- user titles must be ordered first, got titles=${JSON.stringify(plan.titles)}`);
      }
      // With the 3 user titles placed first, only 17 of the audit's 20
      // additions fit under the 20-item cap -- proving eviction fell on the
      // MODEL's additions, never the user's titles (the old append-at-the-end
      // order would instead have evicted the 3 just-restored user titles).
      const survivingAdditions = plan.titles.filter(t => coverageAdditions.includes(t));
      assert(survivingAdditions.length === 17,
        `truncation must evict model additions from the END, never the user's titles; expected 17 surviving additions, got ${survivingAdditions.length} (titles=${JSON.stringify(plan.titles)})`);

      // The manifest-durable normalizer every persisted plan passes through
      // must not re-open the truncation and drop a user title a second time.
      const roundTripped = normalizeJobPreferencePlan(plan);
      for (const title of userTitles) {
        assert(roundTripped.titles.includes(title),
          `user-authored titles must survive a normalizeJobPreferencePlan round-trip too, got titles=${JSON.stringify(roundTripped.titles)}`);
      }
      assert(roundTripped.titles.length <= 20, 'normalizeJobPreferencePlan round-trip must still respect MAX_TITLES=20');

      return { cappedAtMax: true, userTitlesSurvived: true, roundTripSurvived: true };
    },
  },
  {
    // New coverage: deriveGatePinnedTitles/deriveQueryTitles collapsed into
    // one deriveSearchTitles (there is no more gate/query split to test
    // separately -- the deterministic gate is gone). A legacy targetRole
    // (unmigrated canvas, no AI-plan concept) still wins outright,
    // reproducing the old single-role search exactly; otherwise the locked
    // plan's AI-determined titles drive the search unconditionally; a
    // malformed or missing plan must degrade to an empty list, never throw.
    name: 'REGRESSION: deriveSearchTitles -- legacy targetRole wins outright; otherwise preferencePlan.titles; malformed/missing plan yields []',
    run: async () => {
      const search = await fs.promises.readFile('src/nodes/JobSearchNode.jsx', 'utf8');
      const body = extractFunction(search, 'function deriveSearchTitles(targetRole, preferencePlan) {', 'deriveSearchTitles');
      const deriveSearchTitles = new Function(`${body}\nreturn deriveSearchTitles;`)();

      assert(JSON.stringify(deriveSearchTitles('Data Scientist', { titles: ['Product Manager'] })) === JSON.stringify(['Data Scientist']),
        'a legacy targetRole must win outright over the plan\'s titles');
      assert(JSON.stringify(deriveSearchTitles('', { titles: ['Product Manager', 'Senior Product Manager'] })) === JSON.stringify(['Product Manager', 'Senior Product Manager']),
        'with no targetRole, the preferencePlan\'s AI-determined titles must drive the search verbatim');
      assert(JSON.stringify(deriveSearchTitles('', null)) === '[]', 'a missing plan must yield an empty title list, not throw');
      assert(JSON.stringify(deriveSearchTitles('', undefined)) === '[]', 'an undefined plan must yield an empty title list, not throw');
      assert(JSON.stringify(deriveSearchTitles('', { titles: 'not-an-array' })) === '[]', 'a malformed (non-array) titles field must yield an empty list');
      assert(JSON.stringify(deriveSearchTitles('', { titles: ['Valid', '', '   ', 42, null] })) === JSON.stringify(['Valid']),
        'blank and non-string entries in titles must be filtered out');

      return { legacyWins: true, planTitlesUsed: true, malformedIsSafe: true };
    },
  },
  {
    // FIX2: the lock-existence sentinel must be keyed on resolvedRolesMeta
    // (written iff a resolution actually ran), NOT resolvedRoles.length > 0
    // (which cannot distinguish a legitimate zero-title resolution from
    // "never locked"). Before this fix, a hub whose brief resolved to zero
    // titles would report `hasLockedRoles === false` forever, re-paying the
    // two-pass resolution handoff on every future scan and never freezing
    // settings. JobSearchDoneState.jsx was just fixed to duplicate this exact
    // sentinel (it cannot import JobSearchNode.jsx's hasResolvedRoleLock --
    // that file already imports JobSearchDoneState.jsx, so importing back
    // would be circular) -- both copies are asserted to agree here so a
    // future edit to one that isn't mirrored in the other is caught.
    name: 'REGRESSION FIX2: hasResolvedRoleLock (and its JobSearchDoneState.jsx duplicate) treats a zero-title resolution as LOCKED (resolvedRolesMeta-keyed, not resolvedRoles.length)',
    run: async () => {
      const search = await fs.promises.readFile('src/nodes/JobSearchNode.jsx', 'utf8');
      const body = extractFunction(search, 'function hasResolvedRoleLock(source) {', 'hasResolvedRoleLock');
      const hasResolvedRoleLock = new Function(`${body}\nreturn hasResolvedRoleLock;`)();

      // The exact failure mode: a resolution ran and legitimately produced
      // zero titles (resolvedRoles: [] is a VALID outcome -- see
      // resolveSearchRoles for when interpretJobPreferences short-circuits
      // on a genuinely empty brief), but resolvedRolesMeta was still
      // written because the resolution DID run. Shape mirrors the real
      // freshRoleLockPatch in JobSearchNode.jsx: { derivedAt, roleAudit }.
      assert(hasResolvedRoleLock({ resolvedRoles: [], resolvedRolesMeta: { derivedAt: 't', roleAudit: null } }) === true,
        'a zero-title resolution must still count as LOCKED -- the old `resolvedRoles.length > 0` sentinel would wrongly report false here, re-running the resolver on every future scan');
      // Never locked at all: no resolvedRolesMeta.
      assert(hasResolvedRoleLock({ resolvedRoles: [] }) === false,
        'a hub with no resolvedRolesMeta must report unlocked, even if resolvedRoles happens to be an (empty) array');
      assert(hasResolvedRoleLock(undefined) === false && hasResolvedRoleLock(null) === false,
        'hasResolvedRoleLock must be defensive against a missing source object entirely');
      // The ordinary non-empty case must obviously still read as locked.
      assert(hasResolvedRoleLock({ resolvedRoles: ['Product Manager'], resolvedRolesMeta: { derivedAt: 't', roleAudit: null } }) === true,
        'a normal non-empty resolution must read as locked');

      // The duplicated sentinel in JobSearchDoneState.jsx (settingsFrozen)
      // must agree exactly -- extracted as the real source line, not a
      // paraphrase, so a drift between the two copies is caught here rather
      // than shipping as a UI that disagrees with the actual lock state.
      const doneStateSrc = await fs.promises.readFile('src/nodes/jobsearch/JobSearchDoneState.jsx', 'utf8');
      const settingsFrozenLine = extractLine(doneStateSrc, 'const settingsFrozen = !!(resolvedRolesMeta', 'JobSearchDoneState settingsFrozen sentinel');
      const settingsFrozenFromDoneState = new Function('resolvedRolesMeta', `${settingsFrozenLine}\nreturn settingsFrozen;`);

      assert(settingsFrozenFromDoneState({ derivedAt: 't', roleAudit: null }) === true,
        'JobSearchDoneState.jsx\'s settingsFrozen must treat a present resolvedRolesMeta as frozen, mirroring hasResolvedRoleLock');
      assert(settingsFrozenFromDoneState(null) === false && settingsFrozenFromDoneState(undefined) === false,
        'JobSearchDoneState.jsx\'s settingsFrozen must treat a missing resolvedRolesMeta as unfrozen, mirroring hasResolvedRoleLock');

      return { zeroTitleLockDetected: true, doneStateSentinelAgrees: true };
    },
  },
  {
    // FIX6 successor: the old encoding-blind traceability check ran only for
    // titleSource='brief' and only THREW on a genuine mismatch. Single mode
    // has no titleSource to gate on, and the guarantee moved from a
    // reject-on-audit-response check to a REPAIR performed by
    // resolveSearchRoles itself, AFTER pass 2, deterministically: any draft
    // title the user actually wrote in the brief (matched NFC/NFD-blind --
    // career text is routinely PDF/OCR-derived and yields NFD) that the
    // pass-2 audit dropped is restored, and the repair is recorded in
    // roleAudit.restoredUserTitles. This is asserted alongside its control: a
    // title the MODEL added (never present in the brief) that the audit
    // legitimately removed must stay removed and must never be resurrected
    // into restoredUserTitles -- the repair protects only the user's own
    // words, never the model's own retracted draft.
    name: 'REGRESSION FIX6: resolveSearchRoles repairs a SILENTLY dropped user-written title (NFC/NFD- and punctuation-blind), respects a DECLARED compliance removal, and never reinstates a title the brief excluded',
    run: async () => {
      // NFC (precomposed, single codepoint U+00E9) vs NFD ("e" + combining
      // acute accent U+0301) spellings of the same word -- visually
      // identical, byte-distinct.
      const titleNFC = 'Café Manager';
      const modelAddedTitle = 'Staff Café Manager';
      const briefNFD = `Please only search for the ${titleNFC.normalize('NFD')} role, nothing else.`;

      // Prove the fixture actually exercises the encoding mismatch -- a test
      // built from two literals that happened to already match would catch
      // nothing.
      assert(titleNFC.normalize('NFD') !== titleNFC, 'fixture bug: titleNFC must be NFC-encoded, so its NFD form must differ from itself');
      assert(briefNFD.normalize('NFC') !== briefNFD, 'fixture bug: briefNFD must actually contain a decomposed (NFD) sequence -- its NFC-normalized form must differ from itself');

      let auditCalled = false;
      const { plan, roleAudit } = await resolveSearchRoles({
        jobPreferences: briefNFD,
        profile: {}, careerData: '',
        callText: async (_prompt, options) => {
          if (options.task === 'job-preference-interpretation') return rawPlan([titleNFC, modelAddedTitle]);
          if (options.task === 'job-role-audit') {
            auditCalled = true;
            // A real audit response shape. The user's own verbatim title
            // vanishes from `titles` WITHOUT being declared in `removed` --
            // that silent drop is the malfunction the deterministic repair
            // exists for. The model's own added title is removed properly,
            // i.e. DECLARED, which must be respected.
            return {
              titles: ['Café Operations Manager'],
              added: ['Café Operations Manager'], addedReason: 'broader coverage',
              removed: [modelAddedTitle], removedReason: 'violates the brief\'s level constraint',
              rationale: 'test fixture',
            };
          }
          throw new Error(`unexpected task '${options.task}'`);
        },
      });
      assert(auditCalled, 'fixture bug: pass 2 must actually run for this test to prove anything');

      // The user's own verbatim title must be REPAIRED back in,
      // deterministically -- not merely left to the model's discretion.
      assert(plan.titles.includes(titleNFC), `the user-written title must be restored into the final plan even though the audit dropped it, got titles=${JSON.stringify(plan.titles)}`);
      assert(Array.isArray(roleAudit.restoredUserTitles) && roleAudit.restoredUserTitles.length === 1 && roleAudit.restoredUserTitles[0] === titleNFC,
        `the restoration must be recorded in roleAudit.restoredUserTitles, got ${JSON.stringify(roleAudit.restoredUserTitles)}`);

      // Negative control: a model-added title that the audit legitimately
      // removed must stay removed, and must never appear in
      // restoredUserTitles -- proves the repair isn't vacuously permissive
      // (i.e. it doesn't just restore whatever pass 1 drafted).
      assert(!plan.titles.includes(modelAddedTitle), 'a model-added title the audit legitimately removed must stay removed');
      assert(!roleAudit.restoredUserTitles.includes(modelAddedTitle), 'a legitimately-removed MODEL title must never appear in restoredUserTitles');

      // A DECLARED removal is a deliberate, auditable compliance decision and
      // must NOT be reversed by the repair -- otherwise an exclusion clause
      // defeats itself. Naming a title in the brief is not proof the user
      // wants it: "NOT interested in Staff Engineer" contains "Staff Engineer"
      // verbatim, so every containment test reads it as user-authored. This is
      // the audit prompt's own worked example, so it is the likeliest case.
      const excludedTitle = 'Staff Engineer';
      const exclusionBrief = `Individual contributor roles: Software Engineer. I am NOT interested in ${excludedTitle} positions.`;
      const excluded = await resolveSearchRoles({
        jobPreferences: exclusionBrief,
        profile: {}, careerData: '',
        callText: async (_prompt, options) => {
          if (options.task === 'job-preference-interpretation') return rawPlan(['Software Engineer', excludedTitle]);
          if (options.task === 'job-role-audit') {
            return {
              titles: ['Software Engineer'],
              added: [], addedReason: '',
              removed: [excludedTitle], removedReason: 'the brief explicitly excludes this level',
              rationale: 'test fixture',
            };
          }
          throw new Error(`unexpected task '${options.task}'`);
        },
      });
      assert(!excluded.plan.titles.includes(excludedTitle),
        `a title the brief EXCLUDED must never be reinstated by the repair, got titles=${JSON.stringify(excluded.plan.titles)}`);
      assert(Array.isArray(excluded.roleAudit.auditRemovedUserTitles) && excluded.roleAudit.auditRemovedUserTitles.includes(excludedTitle),
        'a declared removal of a brief-named title must still be RECORDED, not silently accepted');

      // Punctuation drift: pass 1 is asked to copy verbatim but routinely
      // re-spaces delimiters. The repair must still recognize its own title.
      const drift = await resolveSearchRoles({
        jobPreferences: 'Looking for UX/UI Designer work.',
        profile: {}, careerData: '',
        callText: async (_prompt, options) => {
          if (options.task === 'job-preference-interpretation') return rawPlan(['UX / UI Designer', 'Product Designer']);
          if (options.task === 'job-role-audit') {
            return { titles: ['Product Designer'], added: [], addedReason: '', removed: [], removedReason: '', rationale: 'test fixture' };
          }
          throw new Error(`unexpected task '${options.task}'`);
        },
      });
      assert(drift.plan.titles.includes('UX / UI Designer'),
        `the repair must be blind to punctuation spacing drift, got titles=${JSON.stringify(drift.plan.titles)}`);

      return { userTitleRestored: true, modelTitleStaysRemoved: true, exclusionRespected: true, punctuationDriftHandled: true };
    },
  },
  {
    // FIX7 (unchanged behavior): resolveSearchRoles must not silently return
    // a zero-title plan as if it were a final, legitimate answer for a
    // NON-empty brief -- that used to lock an empty resolvedRoles forever,
    // discarding the paid-for interpretation handoff's result. It must still
    // treat a genuinely EMPTY brief's short-circuit (aiSkipped) as
    // legitimate, so this test asserts BOTH directions from real callText
    // fixtures, exactly mirroring the two branches resolveSearchRoles
    // actually has. Single mode does not change either branch: the "no
    // titles for a non-empty brief" throw and the aiSkipped short-circuit
    // both predate and survive the titleSource removal.
    name: 'REGRESSION FIX7: resolveSearchRoles throws when a non-empty brief resolves to zero titles, but not for a genuinely empty brief',
    run: async () => {
      let thrown = null;
      try {
        await resolveSearchRoles({
          jobPreferences: 'Find me something interesting, I am flexible on the specific title.',
          profile: {}, careerData: '',
          callText: async (_prompt, options) => {
            if (options.task === 'job-preference-interpretation') return rawPlan([]);
            throw new Error(`pass 2 must not run -- pass 1 already failed the "must resolve at least one title" contract, got task '${options.task}'`);
          },
        });
      } catch (err) { thrown = err; }
      assert(thrown instanceof Error && /no titles/i.test(thrown.message),
        `a non-empty brief resolving to zero titles must throw a clear error, got: ${thrown ? thrown.message : '(no throw -- silently returned an empty plan)'}`);

      // Contrast case: a genuinely EMPTY brief is interpretJobPreferences's
      // own short-circuit (aiSkipped) -- zero titles here IS the legitimate,
      // final answer, and callText must never even be invoked. A fix that
      // over-corrected FIX7 into "throw on ANY zero-title result" would fail
      // this half.
      let calledForEmptyBrief = false;
      const emptyResult = await resolveSearchRoles({
        jobPreferences: '',
        profile: {}, careerData: '',
        callText: async () => { calledForEmptyBrief = true; throw new Error('must not be called for a genuinely empty brief'); },
      });
      assert(!calledForEmptyBrief && emptyResult.plan.titles.length === 0 && emptyResult.roleAudit === null,
        'a genuinely empty brief must resolve to zero titles as a legitimate no-op, with no AI call at all');

      return { nonEmptyBriefThrows: true, emptyBriefLegitimate: true };
    },
  },
  {
    // New coverage: under the old two-mode design, pass 2 (the coverage/
    // compliance audit) was SKIPPED whenever titleSource='brief' -- the
    // user's own words were trusted through untouched, so there was nothing
    // to audit. Single mode always runs pass 1 AND pass 2 for a non-empty
    // brief, even when the brief names the titles itself, because the
    // model's OWN additions around those titles can still miss a role family
    // or violate a stated exclusion. This must hold in both directions: pass
    // 2 genuinely runs (spends the handoff) for a non-empty brief, and is
    // genuinely never invoked (zero handoffs) for a brief that is truly
    // empty.
    name: 'REGRESSION: resolveSearchRoles always runs pass 2 (job-role-audit) for a non-empty brief -- even one whose titles are the user\'s own verbatim words -- and never for a genuinely empty one',
    run: async () => {
      const tasksInvoked = [];
      let auditInvoked = false;
      await resolveSearchRoles({
        jobPreferences: 'Only Product Manager roles, nothing else.',
        profile: {}, careerData: '',
        callText: async (_prompt, options) => {
          tasksInvoked.push(options.task);
          if (options.task === 'job-preference-interpretation') return rawPlan(['Product Manager']);
          if (options.task === 'job-role-audit') {
            auditInvoked = true;
            return { titles: ['Product Manager'], added: [], addedReason: '', removed: [], removedReason: '', rationale: 'draft already covers the brief' };
          }
          throw new Error(`unexpected task '${options.task}'`);
        },
      });
      assert(auditInvoked, 'pass 2 (job-role-audit) must run for a non-empty brief, even when the brief named the title itself -- the old titleSource="brief" design skipped it here');
      assert(JSON.stringify(tasksInvoked) === JSON.stringify(['job-preference-interpretation', 'job-role-audit']),
        `exactly the two expected handoffs must run, in order; got ${JSON.stringify(tasksInvoked)}`);

      let handoffsForEmptyBrief = 0;
      const emptyResult = await resolveSearchRoles({
        jobPreferences: '',
        profile: {}, careerData: '',
        callText: async () => { handoffsForEmptyBrief += 1; throw new Error('must not be called for a genuinely empty brief'); },
      });
      assert(handoffsForEmptyBrief === 0 && emptyResult.roleAudit === null && emptyResult.plan.titles.length === 0,
        'a genuinely empty brief must cost zero AI handoffs and resolve to a legitimate empty role set');

      return { pass2AlwaysRunsForNonEmptyBrief: true, emptyBriefZeroHandoffs: true };
    },
  },
  {
    // FIX9 successor: the manifest-durable plan sanitizer must round-trip
    // `titles` (previously dropped entirely, replaced by the retired
    // targetRoleConflict fields), and `titleSource` must now be ENTIRELY
    // absent from the sanitized result -- not defaulted to 'generated' (the
    // old fix's contract), but gone, because the two-mode design it
    // discriminated between no longer exists. Also covers the accompanying
    // `meaningful` predicate: a plan with ONLY resolved titles (no summary/
    // direction/preference text) must survive, not be discarded as "empty".
    name: 'REGRESSION FIX9: sanitizeJobPreferencePlan round-trips titles, drops titleSource entirely, and a titles-only plan is not discarded as empty',
    run: () => {
      const plan = rawPlan(['Product Manager', 'Senior Product Manager']);
      const sanitized = sanitizeJobPreferencePlan(plan);
      assert(sanitized !== null, 'a plan with titles must not be discarded');
      assert(JSON.stringify(sanitized.titles) === JSON.stringify(['Product Manager', 'Senior Product Manager']),
        `sanitizeJobPreferencePlan must round-trip titles verbatim (bounded); got titles=${JSON.stringify(sanitized.titles)}`);
      assert(!Object.hasOwn(sanitized, 'titleSource'),
        'titleSource must be entirely absent from the sanitized result -- the two-mode design is gone, there is nothing left to persist a mode for');

      // A stray titleSource on the INPUT (an old persisted manifest from
      // before the single-mode migration) must simply be ignored, never
      // echoed through.
      const legacyInput = { ...rawPlan(['Data Analyst']), titleSource: 'brief' };
      const sanitizedLegacy = sanitizeJobPreferencePlan(legacyInput);
      assert(!Object.hasOwn(sanitizedLegacy, 'titleSource'), 'a titleSource present on an old persisted input must not survive sanitization');
      assert(JSON.stringify(sanitizedLegacy.titles) === JSON.stringify(['Data Analyst']), 'titles must still round-trip even when the input carries a stray legacy titleSource');

      // The `meaningful` predicate: a plan with resolved titles but nothing
      // else must survive (this is exactly the shape a Search-Brief-only
      // interpretation produces -- before this fix, it was silently
      // dropped, and resuming the run then looked like it had never resolved
      // a plan at all).
      const titlesOnlyPlan = rawPlan(['Data Analyst']);
      const sanitizedTitlesOnly = sanitizeJobPreferencePlan(titlesOnlyPlan);
      assert(sanitizedTitlesOnly !== null && sanitizedTitlesOnly.titles.length === 1,
        'a plan whose ONLY content is resolved titles must not be discarded as "empty" by the meaningful predicate');

      // A truly empty plan (no titles, no summary, no direction, no
      // preferences, no warnings) must still sanitize to null -- the fix
      // must not have made every empty-looking plan "meaningful".
      const trulyEmptyPlan = rawPlan([]);
      assert(sanitizeJobPreferencePlan(trulyEmptyPlan) === null,
        'a genuinely empty plan must still sanitize to null');

      return { roundTrips: true, titleSourceAbsent: true, titlesOnlySurvives: true, genuinelyEmptyStillNull: true };
    },
  },
  {
    // FIX10 (unchanged): the resolved-titles EventLogger line
    // ("...skipping query generation and searching them directly: <titles>")
    // has no closing quote to anchor a redaction on (unlike the other
    // prose-form clauses), so it needed its own regex clause consuming to
    // end-of-line. Assert the private title text is actually gone from the
    // output, not merely that SOME redaction ran. Unaffected by the
    // titleSource removal -- the log line's wording and the redaction regex
    // are both unchanged.
    name: 'REGRESSION FIX10: redactReportEventHistoryLine strips the resolved Search-Brief titles from the "skipping query generation" log line',
    run: () => {
      const line = '[JobSearch][node-42] Job Preferences produced 2 title(s) -- skipping query generation and searching them directly: Senior Director of Confidential Restructuring, VP of Secret Layoffs';
      const redacted = redactReportEventHistoryLine(line);
      assert(!redacted.includes('Senior Director of Confidential Restructuring') && !redacted.includes('VP of Secret Layoffs'),
        `the private resolved titles must not survive redaction, got: ${redacted}`);
      assert(redacted.includes('[redacted titles]'), `the redaction placeholder must be present, got: ${redacted}`);
      // The prefix (event context, node id, count) is diagnostic and must be
      // preserved -- this is a redaction, not a line-drop.
      assert(redacted.includes('[JobSearch][node-42]') && redacted.includes('Job Preferences produced 2 title(s)'),
        'the surrounding diagnostic context (node id, title count) must survive -- only the titles themselves are sensitive');
      return { titlesRedacted: true, contextPreserved: true };
    },
  },
  {
    // FIX11 (unchanged behavior): once a hub's role lock is engaged
    // (resolvedRolesMeta present), Undo must not be able to revert any of the
    // now-frozen Search Brief settings back to their pre-lock value -- that
    // would desync the visible settings from the still-locked resolvedRoles/
    // searchBriefPlan. An UNLOCKED hub must be completely unaffected: its
    // settings remain ordinarily undo-restorable. Both directions are
    // asserted from the same real exported merge function, on two sibling
    // hubs in one call, so a regression that broke either direction
    // independently is caught. Unaffected by the titleSource removal --
    // mergeNonRestorableNodeDataFromLive still keys on resolvedRolesMeta.
    name: 'REGRESSION FIX11: Undo cannot revert a frozen setting on a role-locked hub, but still reverts settings on an unlocked hub',
    run: () => {
      const liveNodes = [
        {
          id: 'hub-locked',
          type: 'jobhub',
          data: {
            resolvedRoles: ['Product Manager'],
            resolvedRolesMeta: { derivedAt: 't', roleAudit: null },
            searchBriefPlan: rawPlan(['Product Manager']),
            jobPreferences: 'LIVE locked brief text',
            searchLocation: 'LIVE location',
            locked: false,
          },
        },
        {
          id: 'hub-unlocked',
          type: 'jobhub',
          data: {
            resolvedRoles: [],
            resolvedRolesMeta: null,
            searchBriefPlan: null,
            jobPreferences: 'LIVE unlocked brief text',
            searchLocation: 'LIVE unlocked location',
            locked: false,
          },
        },
      ];
      // The "restored" snapshot Undo is trying to revert TO -- a pre-lock
      // (or otherwise earlier) state with different setting values, plus the
      // unrelated canvas Lock Node toggle flipped, which must always stay
      // undo-restorable regardless of role-lock state.
      const restoredNodes = [
        {
          id: 'hub-locked',
          type: 'jobhub',
          data: {
            resolvedRoles: [], resolvedRolesMeta: null, searchBriefPlan: null,
            jobPreferences: 'OLD pre-lock brief text',
            searchLocation: 'OLD pre-lock location',
            locked: true,
          },
        },
        {
          id: 'hub-unlocked',
          type: 'jobhub',
          data: {
            resolvedRoles: [], resolvedRolesMeta: null, searchBriefPlan: null,
            jobPreferences: 'OLD unlocked brief text',
            searchLocation: 'OLD unlocked location',
            locked: true,
          },
        },
      ];

      const merged = mergeNonRestorableNodeDataFromLive(restoredNodes, liveNodes);
      const mergedLocked = merged.find(n => n.id === 'hub-locked');
      const mergedUnlocked = merged.find(n => n.id === 'hub-unlocked');

      assert(mergedLocked.data.jobPreferences === 'LIVE locked brief text' && mergedLocked.data.searchLocation === 'LIVE location',
        `a frozen setting on a role-locked hub must NOT be reverted by Undo, got jobPreferences=${JSON.stringify(mergedLocked.data.jobPreferences)} searchLocation=${JSON.stringify(mergedLocked.data.searchLocation)}`);
      assert(mergedLocked.data.locked === true,
        "the unrelated canvas Lock Node toggle ('locked') must remain undo-restorable even while the hub's role lock is engaged");

      assert(mergedUnlocked.data.jobPreferences === 'OLD unlocked brief text' && mergedUnlocked.data.searchLocation === 'OLD unlocked location',
        'settings on an UNLOCKED hub must remain ordinarily undo-restorable -- FIX11 must not have frozen every jobhub, only role-locked ones');

      return { lockedFrozen: true, unlockedStillUndoable: true };
    },
  },
  {
    // FIX3 (unchanged): JobBoardNode's connected-Search label must prefer
    // the durable, once-locked resolvedRoles over the per-run pinnedTitles
    // (which resets to [] at the start of every run and is blank before the
    // first run and after every reload). Falls back to pinnedTitles only
    // when resolvedRoles is empty. Unaffected by the titleSource removal --
    // moduleLabel never read titleSource.
    name: 'REGRESSION FIX3: moduleLabel prefers durable resolvedRoles over per-run pinnedTitles',
    run: async () => {
      const board = await fs.promises.readFile('src/nodes/JobBoardNode.jsx', 'utf8');
      const body = extractFunction(board, 'function moduleLabel(d) {', 'moduleLabel');
      const moduleLabel = new Function(`${body}\nreturn moduleLabel;`)();

      // The bug: pinnedTitles resets to [] at the start of every run, so
      // reading it alone made a Board's label for a connected, ALREADY-
      // LOCKED Search go blank before the first run and after every reload.
      assert(moduleLabel({ resolvedRoles: ['Product Manager'], pinnedTitles: [], preferredLocation: 'Remote' }) === 'Product Manager · Remote',
        'moduleLabel must read the durable resolvedRoles even while pinnedTitles is (correctly, per-run) empty');
      // resolvedRoles must win even when a stale pinnedTitles from a prior
      // run is still present.
      assert(moduleLabel({ resolvedRoles: ['Product Manager'], pinnedTitles: ['Stale Old Title'], preferredLocation: 'Remote' }) === 'Product Manager · Remote',
        'moduleLabel must prefer resolvedRoles over a stale pinnedTitles, not merely over an empty one');
      // Fallback: a hub that has never locked (fresh, or a legacy/unmigrated
      // canvas) still shows something useful mid-run via pinnedTitles.
      assert(moduleLabel({ resolvedRoles: [], pinnedTitles: ['Mid-run Title'], preferredLocation: '' }) === 'Mid-run Title',
        'moduleLabel must fall back to pinnedTitles only when resolvedRoles is empty (never-locked or legacy hub)');
      assert(moduleLabel({ resolvedRoles: [], pinnedTitles: [] }) === 'Job Search',
        'moduleLabel must fall back to the generic "Job Search" label when neither list has a role');

      return { resolvedRolesPreferred: true, staleOverridden: true, fallbackWorks: true };
    },
  },
];
