import { assert, canAttemptJobSourceResolve, isJobSourceWarningGating, isTerminalSourceStatus } from '../test-dependencies.js';
import { isSolveIpcCancellation, isSolveIpcFailure, solveIpcFailureMessage } from '../../src/utils/solveIpcFailure.js';
import fs from 'node:fs';

export default [
  {
    name: 'Solve IPC failures use concise, actionable browser guidance',
    run: () => {
      assert(isSolveIpcFailure({ success: false, error: 'Failed to launch the browser process: Opening in existing browser session.' }),
        'handleSafe failure envelope is recognized');
      assert(isSolveIpcFailure(undefined) && isSolveIpcFailure({}) && !isSolveIpcFailure({ success: true }),
        'missing or malformed Solve IPC results fail closed while explicit handleSafe success passes');
      assert(isSolveIpcCancellation({ success: false, error: 'Node deleted' })
        && isSolveIpcCancellation(Object.assign(new Error('cancelled'), { name: 'AbortError' }))
        && !isSolveIpcCancellation({ success: false, error: 'Chrome launch timed out' }),
      'lifecycle cancellations stay distinct from actionable browser launch failures');
      assert(/shared browser session/i.test(solveIpcFailureMessage({ error: 'Chrome launch blocked by the shared browser profile lock after 6 attempts' })),
        'profile collisions receive retry guidance');
      assert(/did not reach the site/i.test(solveIpcFailureMessage({ error: 'Captcha navigation stuck at about:blank' })),
        'blank navigation receives targeted guidance');
      const generic = solveIpcFailureMessage({ error: 'line one\nline two\n'.repeat(100) });
      assert(generic.length < 100 && !generic.includes('line one'),
        'raw multi-line diagnostics never become persisted card copy');
      return { ok: true };
    },
  },
  {
    name: 'shared-profile readers and login entrypoints retain explicit lock boundaries',
    run: () => {
      const accounts = fs.readFileSync(new URL('../../electron/ipc/accounts.js', import.meta.url), 'utf8');
      const jobs = fs.readFileSync(new URL('../../electron/ipc/jobs.js', import.meta.url), 'utf8');
      const marketplace = fs.readFileSync(new URL('../../electron/ipc/marketplace.js', import.meta.url), 'utf8');
      const listingStatus = fs.readFileSync(new URL('../../electron/ipc/listingStatusCheck.js', import.meta.url), 'utf8');
      const mutex = fs.readFileSync(new URL('../../electron/ipc/asyncMutex.js', import.meta.url), 'utf8');
      const authWindows = fs.readFileSync(new URL('../../electron/ipc/browser/authWindows.js', import.meta.url), 'utf8');
      assert(accounts.includes("withSharedProfileLock(runFlow, signal, `accounts login:${platformId}`)"),
        'external Accounts login registers a shared-profile-locked single flight');
      assert(accounts.includes('accounts startup verify:${platformId}'),
        'startup verification holds the profile during its browser read');
      assert(accounts.includes('verifyAbort.abort(new Error(timeoutReason))')
        && accounts.includes('verifySellMonitorLogin(platformId, { signal: verifyAbort.signal })')
        && accounts.includes('signal,'),
      'startup timeout aborts and awaits the actual verifier instead of releasing a detached reader');
      assert(accounts.includes("handleSafe('open-login-window', async (_event, { platformId }, signal)")
        && accounts.includes("handleSafe('check-and-login', async (_event, { platformId }, signal)"),
      'Accounts login entrypoints pass sender cancellation into the shared single-flight');
      assert(accounts.includes('openLoginWindow(platformId, sender, signal)')
        && accounts.includes('completeLoginWindowVerification(platformId, result, { signal })')
        && authWindows.includes('openLoginWindow(platformId, sender = null, signal = null)')
        && authWindows.includes("openNativeLoginWindow({ platformId, url, executablePath, sender, signal })")
        && authWindows.includes("signal.addEventListener('abort', onAbort, { once: true })"),
      'post-acquisition cancellation reaches both Puppeteer and native login window lifecycles');
      assert(jobs.includes("runPlatformLoginFlow('indeed', event.sender, { signal })")
        && !jobs.includes('profileLockHeld'),
      'Jobs native-login lets Accounts register single-flight before waiting on the lock');
      assert(jobs.includes("'job Indeed native challenge'")
        && jobs.includes("'job Indeed resume scrape'")
        && jobs.includes('job LinkedIn description recovery:${nodeId}'),
      'Jobs shared profile acquisition labels identify the actual browser workflow');
      assert(marketplace.includes('marketplace status verify:${platformId}')
        && marketplace.includes('marketplace status fetch:${platformId}'),
      'Marketplace status locks verification and fetch readers separately from LLM analysis');
      assert(listingStatus.includes('withSharedProfileLock(')
        && listingStatus.includes('marketplace status disambiguate:${platformId}')
        && listingStatus.includes('verifyPlatformOnce(platformId, signal)')
        && listingStatus.includes("e?.name === 'AbortError') throw e"),
      'auth-wall disambiguation verifier is also protected by the shared profile FIFO');
      assert(mutex.includes('execution.then(settle, settle)')
        && !mutex.includes('result.then(settle, settle)'),
      'queue diagnostics retain an early-aborted physical FIFO entry until its turn settles');
      return { ok: true };
    },
  },
  {
    name: 'renderer Solve failures restore actionable state for envelopes and rejected invokes',
    run: () => {
      const jobSource = fs.readFileSync(new URL('../../src/nodes/JobSourceCardNode.jsx', import.meta.url), 'utf8');
      const compSource = fs.readFileSync(new URL('../../src/nodes/CompSourceCardNode.jsx', import.meta.url), 'utf8');
      const jobCard = fs.readFileSync(new URL('../../src/nodes/JobCardNode.jsx', import.meta.url), 'utf8');
      assert(jobSource.includes('const externalOpenInFlightRef = useRef(false);')
        && jobSource.includes('if (resolving || externalOpenInFlightRef.current) return;')
        && jobSource.includes('externalOpenInFlightRef.current = true;'),
      'job-source external opens have a synchronous click latch before awaiting Electron');
      assert(jobSource.includes('const solveFailure = failureError.solveIpcResult || {')
        && jobSource.includes('isSolveIpcCancellation(solveFailure)')
        && jobSource.includes('!resolverAlive() || !capturedRunIsCurrent()')
        && jobSource.includes("title: 'Solve could not open'")
        && jobSource.includes('warningForSolveIpcFailure(prevForRestore?.warning, solveIpcResult)'),
      'job-source rejected invokes are normalized to friendly Solve feedback and restored warning state');
      assert(jobSource.includes('if (!failureError.solveIpcResult) {\n            EventLogger.error('),
        'a handleSafe Solve envelope is logged once at conversion time rather than producing a duplicate renderer error in the catch path');
      const jobSearch = fs.readFileSync(new URL('../../src/nodes/JobSearchNode.jsx', import.meta.url), 'utf8');
      const failedResolveStart = jobSearch.indexOf('const onResolveFailed = (e) =>');
      const failedResolveEnd = jobSearch.indexOf("document.addEventListener('job-source-resolve-failed'", failedResolveStart);
      const failedResolvePath = jobSearch.slice(failedResolveStart, failedResolveEnd);
      assert((jobSource.match(/new CustomEvent\('job-source-resolved'/g) || []).length === 1
        && (jobSource.match(/new CustomEvent\('job-source-resolve-failed'/g) || []).length >= 2
        && jobSource.includes('restorative: true')
        && failedResolvePath.includes("isJobWorkflowDeletionPending(id) && e.detail?.restorative !== true")
        && failedResolvePath.includes('scrapeWarnings: remaining')
        && !failedResolvePath.includes('pendingJobs')
        && !failedResolvePath.includes('gatheredCount')
        && !failedResolvePath.includes('recordResolveMerge'),
      'failed, unresolved, or deletion-interrupted Solve outcomes restore only their warning; they never enter the successful zero-item merge path');
      const normalizedLegacyRunChecks = jobSource.match(/\(prev\?\.jobRunId \|\| null\) === \(jobRunId \|\| null\)/g) || [];
      assert(normalizedLegacyRunChecks.length >= 2,
        'legacy undefined source tokens normalize to null in both early and failure restoration guards');
      assert(compSource.includes('const progressRevisionRef = useRef(0);')
        && compSource.includes('const resolveInFlightRef = useRef(false);')
        && compSource.includes('resolving || resolveInFlightRef.current || hubLocked')
        && compSource.includes('resolveInFlightRef.current = true;')
        && compSource.includes('resolveInFlightRef.current = false;')
        && compSource.includes('isSolveIpcCancellation(result)')
        && compSource.includes('const showSolveFailure = (result) => {')
        && compSource.includes('} catch (error) {')
        && compSource.includes('name: error?.name, error: error?.message || String(error)')
        && compSource.includes('progressRevisionRef.current !== progressRevision'),
      'comp-source Solve has a synchronous click latch, preserves rejected AbortError cancellation, and cannot overwrite newer progress');
      assert(jobCard.includes('const opened = await openExternalUrl(rawUrl, {')
        && jobCard.includes('dedupeKey: `job-research-open-external:${id}`'),
      'research links use the safe external dispatcher instead of leaking rejected invokes');
      return { jobSolveRejected: true, compFreshnessGuard: true, researchLinkSafe: true };
    },
  },
  {
    // Executes the real listener body out of JobSearchNode.jsx (same idiom the
    // extractor tests use for in-page expressions) so the guard and the removal
    // are proven to agree on one set, not merely to look like they do.
    name: 'optimistic retry-start trim never drops a gating warning that sits behind a sibling',
    run: () => {
      const jobSearch = fs.readFileSync(new URL('../../src/nodes/JobSearchNode.jsx', import.meta.url), 'utf8');
      const handlerStart = jobSearch.indexOf('const onRetryStart = (e) => {');
      const handlerEnd = jobSearch.indexOf("document.addEventListener('job-source-retry-start', onRetryStart);", handlerStart);
      assert(handlerStart !== -1 && handlerEnd > handlerStart,
        'the job-source-retry-start listener is still a named handler registered right after its definition');
      const handlerSrc = jobSearch.slice(handlerStart, handlerEnd);
      const makeHandler = ({ hubId, hubRunId, warnings, deletionPending = false, writes }) => new Function(
        'id',
        'isJobWorkflowDeletionPending',
        'jobRunIdRef',
        'scrapeWarningsRef',
        'isJobSourceWarningGating',
        'updateGlobal',
        `${handlerSrc}\nreturn onRetryStart;`,
      )(
        hubId,
        () => deletionPending,
        { current: hubRunId },
        { current: warnings },
        isJobSourceWarningGating,
        (nodeId, patch) => writes.push({ nodeId, patch }),
      );

      // The incident shape: LinkedIn's enrichment warning is appended after the
      // per-source list, so the hard block is NOT the first entry for its source.
      const block = { sourceId: 'linkedin', severity: 'block', code: 'linkedin-blocked' };
      const partial = { sourceId: 'linkedin', severity: 'warn', code: 'linkedin-partial-descriptions' };
      const otherSource = { sourceId: 'google', severity: 'warn', code: 'google-partial-descriptions' };
      const gatedWrites = [];
      makeHandler({
        hubId: 'hub-1',
        hubRunId: 'run-1',
        warnings: [partial, block, otherSource],
        writes: gatedWrites,
      })({ detail: { hubId: 'hub-1', sourceId: 'linkedin', jobRunId: 'run-1' } });
      assert(gatedWrites.length === 1, 'a source with a trimmable sibling still writes exactly once');
      const gatedRemaining = gatedWrites[0].patch.scrapeWarnings;
      assert(gatedRemaining.includes(block) && !gatedRemaining.includes(partial) && gatedRemaining.includes(otherSource),
        'the gate survives the optimistic trim while its non-gating sibling and other sources are handled as before');

      // An all-gating source has nothing stale to trim, so the handler must not
      // write at all — a no-op write would churn hub data on every Solve click.
      const allGatingWrites = [];
      makeHandler({
        hubId: 'hub-1',
        hubRunId: 'run-1',
        warnings: [block, { sourceId: 'linkedin', code: 'linkedin-rate-limited', severity: 'warn' }, otherSource],
        writes: allGatingWrites,
      })({ detail: { hubId: 'hub-1', sourceId: 'linkedin', jobRunId: 'run-1' } });
      assert(allGatingWrites.length === 0, 'a source holding only gating warnings produces no optimistic write');

      // Unchanged behaviour for the case the optimistic trim exists to serve.
      const throttledWrites = [];
      makeHandler({
        hubId: 'hub-1',
        hubRunId: 'run-1',
        warnings: [partial, { sourceId: 'linkedin', severity: 'warn', code: 'linkedin-throttled' }, otherSource],
        writes: throttledWrites,
      })({ detail: { hubId: 'hub-1', sourceId: 'linkedin', jobRunId: 'run-1' } });
      assert(throttledWrites.length === 1
        && throttledWrites[0].patch.scrapeWarnings.length === 1
        && throttledWrites[0].patch.scrapeWarnings[0] === otherSource,
      'with no gate present every entry for the retrying source is still trimmed');

      // Generation and deletion fences must keep behaving as before the change.
      const fencedWrites = [];
      const fenced = makeHandler({
        hubId: 'hub-1',
        hubRunId: 'run-2',
        warnings: [partial, block],
        writes: fencedWrites,
      });
      fenced({ detail: { hubId: 'hub-1', sourceId: 'linkedin', jobRunId: 'run-1' } });
      fenced({ detail: { hubId: 'other-hub', sourceId: 'linkedin', jobRunId: 'run-2' } });
      fenced({ detail: { hubId: 'hub-1', jobRunId: 'run-2' } });
      assert(fencedWrites.length === 0,
        'a stale generation, a foreign hub, or a sourceId-less receipt still trims nothing');
      return { gatePreserved: true, noOpWriteSuppressed: true };
    },
  },
  {
    name: 'job-source Solve restores from a null progress state without throwing',
    run: () => {
      const jobSource = fs.readFileSync(new URL('../../src/nodes/JobSourceCardNode.jsx', import.meta.url), 'utf8');
      const anchor = 'prev && (prev?.jobRunId || null) === (jobRunId || null) && !isTerminalSourceStatus(prev.status)';
      // Pull each real updater out of the file by balancing setProgress's own
      // parens, so this exercises the shipped predicates rather than a copy.
      const updaters = [];
      let at = jobSource.indexOf(anchor);
      while (at !== -1) {
        const open = jobSource.lastIndexOf('setProgress(', at) + 'setProgress'.length;
        let depth = 0;
        let end = open;
        for (; end < jobSource.length; end += 1) {
          if (jobSource[end] === '(') depth += 1;
          else if (jobSource[end] === ')') {
            depth -= 1;
            if (depth === 0) break;
          }
        }
        updaters.push(jobSource.slice(open + 1, end));
        at = jobSource.indexOf(anchor, end);
      }
      assert(updaters.length === 2,
        'both the early-return restore and the Solve-failure restore still share the run-token predicate');

      const prevForRestore = { jobRunId: 'run-1', status: 'error', warning: { sourceId: 'indeed', severity: 'block' } };
      for (const updaterSrc of updaters) {
        const updater = new Function(
          'jobRunId',
          'prevForRestore',
          'isTerminalSourceStatus',
          'warningForSolveIpcFailure',
          'solveIpcResult',
          `return (${updaterSrc});`,
        )('run-1', prevForRestore, isTerminalSourceStatus, (warning) => warning, null);
        // A card that has not received a progress beat yet (fresh mount, or a
        // reset that cleared it) holds null; `prev.status` was unguarded, so
        // this threw inside the React state updater instead of restoring.
        assert(updater(null) === null, 'a null previous progress state passes through untouched');
        assert(updater(undefined) === undefined, 'an undefined previous progress state passes through untouched');
        assert(updater({ jobRunId: 'run-1', status: 'searching' }) === prevForRestore,
          'a live same-generation card is still restored to its pre-Solve snapshot');
        assert(updater({ jobRunId: 'run-2', status: 'searching' })?.jobRunId === 'run-2',
          'a newer generation is still left alone');
        const terminal = { jobRunId: 'run-1', status: 'done' };
        assert(updater(terminal) === terminal, 'a newer terminal beat still wins over the restore');
      }
      return { nullProgressSafe: true };
    },
  },
  {
    // The Solve/Continue button's render gate became single-threaded when the
    // 'Retry verification' actionLabel was dropped: a native-challenge warning
    // carries no actionLabel and no usable url, so its `resumeState` is the ONLY
    // disjunct that can put a button on the card. Simplifying that gate would
    // silently return the user to the original incident — a card whose
    // suggestion says "click Continue again" with no Continue button anywhere —
    // while the whole suite stayed green. Execute the real JSX expressions out
    // of the file (same idiom as the setProgress extraction above) so this pins
    // the shipped behaviour rather than a paraphrase of it.
    name: 'a native-challenge warning still renders Continue, and button, suggestion and title name one action',
    run: () => {
      const jobSource = fs.readFileSync(new URL('../../src/nodes/JobSourceCardNode.jsx', import.meta.url), 'utf8');

      const gateLine = jobSource.split('\n').find(line => line.trimStart().startsWith('{warningCanResolve &&'));
      assert(!!gateLine && gateLine.trimEnd().endsWith('&& ('),
        'the Solve/Continue button is still rendered behind one conditional-render expression');
      const gate = new Function(
        'warningCanResolve', 'progress', 'hasWarn', 'hasInfo', 'warningBlocksScoring',
        `return (${gateLine.trim().replace(/^\{/, '').replace(/&&\s*\($/, '')});`,
      );

      const labelAt = jobSource.indexOf("{resolving ? 'Running…'");
      assert(labelAt !== -1, 'the button label is still a single inline expression');
      const labelLine = jobSource.slice(labelAt, jobSource.indexOf('\n', labelAt)).trim();
      const label = new Function('resolving', 'progress', `return (${labelLine.replace(/^\{/, '').replace(/\}$/, '')});`);

      const titleAt = jobSource.indexOf('title={hubLocked');
      assert(titleAt !== -1, 'the button hover title is still an inline expression keyed off hubLocked');
      const titleOpen = jobSource.indexOf('{', titleAt);
      let depth = 0;
      let titleEnd = titleOpen;
      for (; titleEnd < jobSource.length; titleEnd += 1) {
        if (jobSource[titleEnd] === '{') depth += 1;
        else if (jobSource[titleEnd] === '}') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      const title = new Function(
        'hubLocked', 'hubBoardRecoveryOwned', 'resolverBusy', 'progress',
        `return (${jobSource.slice(titleOpen + 1, titleEnd)});`,
      );

      // Exactly what jobs.js returns for an unconfirmed native verification:
      // no actionLabel, no page url to open — only the resume state.
      const challengeUrl = 'https://www.indeed.com/jobs?q=product+manager&l=Remote';
      const warning = {
        sourceId: 'indeed',
        code: 'scrape-failed',
        severity: 'block',
        resumeState: { mode: 'native-challenge', challengeUrl },
        suggestion: 'Complete the Indeed check in the Chrome window that opened, then click Continue again.',
      };
      const progress = { status: 'error', url: null, warning };
      const renderInputs = (w) => [
        canAttemptJobSourceResolve(w),
        { status: 'error', url: null, warning: w },
        w?.severity === 'warn',
        w?.severity === 'info',
        isJobSourceWarningGating(w),
      ];

      assert(!!gate(...renderInputs(warning)),
        'a native-challenge warning with no actionLabel and no url still renders its action button');
      // Proves the gate is single-threaded: remove the resumeState disjunct's
      // input and the button disappears entirely. That is the incident shape.
      assert(!gate(...renderInputs({ ...warning, resumeState: undefined })),
        'resumeState is the only disjunct carrying a native-challenge button, so the gate may not be simplified away');

      const buttonLabel = label(false, progress);
      const hoverTitle = title(false, false, false, progress);
      assert(buttonLabel === 'Continue', 'the button resolves to Continue with no actionLabel present');
      assert(label(true, progress) === 'Running…', 'an in-flight resolve still shows its running label');
      assert(hoverTitle === 'Continue opens real Chrome to complete Indeed verification, then resumes the search automatically',
        'the hover title is the native-challenge one, not the generic resumable or captcha fallback');
      assert(warning.suggestion.includes(buttonLabel) && hoverTitle.includes(buttonLabel),
        'button, suggestion and hover title all name the same action');
      return { continueButtonRendered: true, oneAction: true };
    },
  },
  {
    // jobs.js now treats an inconclusive native verification poll
    // ('closed'/'timeout') as a fall-through and runs the authoritative resume
    // scrape, so a Solve that started in 'native-challenge' can come back with
    // a completely different warning. Deriving the status chip from the
    // CLICK-TIME mode then printed 'Verification not confirmed' above evidence
    // saying the session was accepted — a verdict no observer made.
    name: 'failed-Solve status copy describes the returned warning, not the click-time resume mode',
    run: () => {
      const jobSource = fs.readFileSync(new URL('../../src/nodes/JobSourceCardNode.jsx', import.meta.url), 'utf8');
      const anchor = 'const rawRestoreWarning = result?.warning || prevForRestore?.warning || null;';
      const start = jobSource.indexOf(anchor);
      const end = jobSource.indexOf('} : null;', start);
      assert(start !== -1 && end > start,
        'the failed-Solve restore still derives one restoreWarning from the raw outcome');
      const derive = new Function(
        'result', 'prevForRestore', 'resumeState',
        `${jobSource.slice(start, end + '} : null;'.length)}\nreturn restoreWarning;`,
      );

      const clickResumeState = { mode: 'native-challenge', challengeUrl: 'https://www.indeed.com/jobs?q=pm' };
      const prevForRestore = {
        jobRunId: 'run-1',
        warning: { code: 'scrape-failed', severity: 'block', resumeState: clickResumeState },
      };

      // The original incident: the poll never observed clearance and jobs.js
      // returns its native-challenge warning, so the chip copy is accurate.
      const nativeAgain = derive(
        { warning: { code: 'scrape-failed', severity: 'block', resumeState: clickResumeState } },
        prevForRestore,
        clickResumeState,
      );
      assert(nativeAgain.shortLabel === 'Verification not confirmed',
        'a returned native-challenge warning keeps the original incident copy');

      // The fall-through: the resume scrape ran and Indeed answered with an
      // endpoint-scoped block. Asserting "not confirmed" here would contradict
      // the evidence rendered immediately below the chip.
      const endpointBlock = {
        code: 'indeed-endpoint-blocked',
        severity: 'block',
        evidence: 'Indeed accepted the session but blocked its search endpoint. Logging in again will not help.',
      };
      const afterFallThrough = derive({ warning: endpointBlock }, prevForRestore, clickResumeState);
      assert(afterFallThrough.shortLabel === undefined,
        'a different returned warning is never overstamped with a verification verdict');
      assert(afterFallThrough.evidence === endpointBlock.evidence && afterFallThrough.code === endpointBlock.code,
        'the returned warning reaches the card intact');
      assert(afterFallThrough.resumeState === clickResumeState,
        'the card still keeps a resume state, so its Continue button survives the fall-through');

      // No warning came back at all: the card falls back to its pre-Solve
      // warning, so the click-time mode IS what the user is looking at.
      const noBackendWarning = derive({ success: false }, prevForRestore, clickResumeState);
      assert(noBackendWarning.shortLabel === 'Verification not confirmed',
        'with no returned warning the click-time native-challenge copy still applies');

      // A backend warning that already labels itself is never overridden.
      const selfLabelled = derive(
        { warning: { code: 'scrape-failed', severity: 'block', shortLabel: 'Indeed sign-in needed', resumeState: clickResumeState } },
        prevForRestore,
        clickResumeState,
      );
      assert(selfLabelled.shortLabel === 'Indeed sign-in needed',
        'a warning that names its own status keeps it');
      return { chipMatchesRenderedWarning: true };
    },
  },
  {
    // onRetryStart keeps a source's GATING warnings while trimming its
    // non-gating siblings. Both restore paths used to collapse every entry for
    // the source into the single restored warning, discarding that preserved
    // gate moments later — which un-paused the hub and let a later Skip
    // auto-resume a run that was still blocked.
    name: 'Solve restore paths keep the gating warnings the retry-start partition preserved',
    run: () => {
      const jobSearch = fs.readFileSync(new URL('../../src/nodes/JobSearchNode.jsx', import.meta.url), 'utf8');
      const identityStart = jobSearch.indexOf('function isSameJobSourceWarningEntry(a, b) {');
      const identityEnd = jobSearch.indexOf('\n}', identityStart) + 2;
      assert(identityStart !== -1 && identityEnd > identityStart,
        'the shared warning-identity helper still exists at module scope');
      const isSameJobSourceWarningEntry = new Function(
        `${jobSearch.slice(identityStart, identityEnd)}\nreturn isSameJobSourceWarningEntry;`,
      )();

      const failedStart = jobSearch.indexOf('const onResolveFailed = (e) =>');
      const failedEnd = jobSearch.indexOf("document.addEventListener('job-source-resolve-failed'", failedStart);
      const resolvedStart = jobSearch.indexOf('const onResolved = (e) => {');
      const resolvedEnd = jobSearch.indexOf("document.addEventListener('job-source-resolved'", resolvedStart);
      assert(failedStart !== -1 && failedEnd > failedStart && resolvedStart !== -1 && resolvedEnd > resolvedStart,
        'both restore listeners are still named handlers registered right after their definitions');

      const makeFailed = ({ hubRunId, warnings, writes, deletionPending = false }) => new Function(
        'id', 'isJobWorkflowDeletionPending', 'jobRunIdRef', 'EventLogger', 'scrapeWarningsRef',
        'isJobSourceWarningGating', 'isSameJobSourceWarningEntry', 'updateGlobal',
        `${jobSearch.slice(failedStart, failedEnd)}\nreturn onResolveFailed;`,
      )(
        'hub-1',
        () => deletionPending,
        { current: hubRunId },
        { log: () => {}, error: () => {} },
        { current: warnings },
        isJobSourceWarningGating,
        isSameJobSourceWarningEntry,
        (nodeId, patch) => writes.push({ nodeId, patch }),
      );

      const makeResolved = ({ hubRunId, warnings, writes, resumed }) => new Function(
        'id', 'isJobWorkflowDeletionPending', 'jobRunIdRef', 'EventLogger',
        'isJobSearchBoardPausedContinuationBlocked', 'getNodes', 'getEdges', 'hubStateRef',
        'sourceWarningOverridesDuringSearchRef', 'pendingJobsRef', 'mergeResolvedSourceItems',
        'gatheredCountRef', 'scrapeWarningsRef', 'updateGlobal', 'isJobSourceWarningGating',
        'isSameJobSourceWarningEntry', 'window', 'resumeScoringRef', 'processingRunsRef',
        'scheduleCleanSourceCardDismiss',
        `${jobSearch.slice(resolvedStart, resolvedEnd)}\nreturn onResolved;`,
      )(
        'hub-1',
        () => false,
        { current: hubRunId },
        { log: () => {}, error: () => {} },
        () => false,
        () => [],
        () => [],
        { current: 'sources-ready' },
        { current: new Map() },
        { current: [] },
        // The merge itself is exercised by the merge tests; this one is about
        // which warnings survive, so items pass straight through.
        (prevPending, items) => ({ fresh: items, mergedPending: prevPending.concat(items), replacedExisting: 0 }),
        { current: 0 },
        { current: warnings },
        (nodeId, patch) => writes.push({ nodeId, patch }),
        isJobSourceWarningGating,
        isSameJobSourceWarningEntry,
        { electronAPI: { recordResolveMerge: () => {} } },
        { current: () => { resumed.push('resume-scoring'); return null; } },
        { current: { active: false } },
        () => {},
      );

      // One source can end a run holding several entries; here LinkedIn holds
      // two gates (a hard block plus the rate limit) and one trimmable sibling.
      const block = { sourceId: 'linkedin', severity: 'block', code: 'linkedin-blocked' };
      const rateLimit = { sourceId: 'linkedin', severity: 'warn', code: 'linkedin-rate-limited' };
      const partial = { sourceId: 'linkedin', severity: 'warn', code: 'linkedin-partial-descriptions' };
      const otherSource = { sourceId: 'google', severity: 'warn', code: 'google-partial-descriptions' };
      const codesFor = (list, sourceId) => list.filter(w => w.sourceId === sourceId).map(w => w.code).sort();

      const failedWrites = [];
      makeFailed({ hubRunId: 'run-1', warnings: [block, rateLimit, partial, otherSource], writes: failedWrites })({
        detail: { hubId: 'hub-1', sourceId: 'linkedin', jobRunId: 'run-1', warning: { severity: 'warn', code: 'linkedin-rate-limited' } },
      });
      assert(failedWrites.length === 1, 'a failed Solve still writes its restored warning list once');
      const failedRemaining = failedWrites[0].patch.scrapeWarnings;
      assert(JSON.stringify(codesFor(failedRemaining, 'linkedin')) === JSON.stringify(['linkedin-blocked', 'linkedin-rate-limited']),
        'the other gate survives the failure restore and the restored warning is not duplicated');
      assert(failedRemaining.includes(otherSource), 'other sources are untouched by a restore');

      // The restored warning IS the only gate: no duplicate, no loss.
      const dedupeWrites = [];
      makeFailed({ hubRunId: 'run-1', warnings: [block, partial], writes: dedupeWrites })({
        detail: { hubId: 'hub-1', sourceId: 'linkedin', jobRunId: 'run-1', warning: { severity: 'block', code: 'linkedin-blocked' } },
      });
      assert(JSON.stringify(codesFor(dedupeWrites[0].patch.scrapeWarnings, 'linkedin')) === JSON.stringify(['linkedin-blocked']),
        'restoring the same gate leaves exactly one copy of it');

      // Fences are unchanged: a stale generation or a foreign hub writes nothing.
      const fencedWrites = [];
      const fenced = makeFailed({ hubRunId: 'run-2', warnings: [block], writes: fencedWrites });
      fenced({ detail: { hubId: 'hub-1', sourceId: 'linkedin', jobRunId: 'run-1', warning: block } });
      fenced({ detail: { hubId: 'other-hub', sourceId: 'linkedin', jobRunId: 'run-2', warning: block } });
      fenced({ detail: { hubId: 'hub-1', jobRunId: 'run-2', warning: block } });
      assert(fencedWrites.length === 0, 'a stale generation, a foreign hub, or a sourceId-less receipt restores nothing');

      // Success path, still warned: the preserved gate must keep the hub paused
      // instead of letting the run auto-resume behind an unresolved block.
      const warnedWrites = [];
      const warnedResumed = [];
      makeResolved({ hubRunId: 'run-1', warnings: [block, rateLimit, partial], writes: warnedWrites, resumed: warnedResumed })({
        detail: {
          hubId: 'hub-1', sourceId: 'linkedin', jobRunId: 'run-1', resolved: true, items: [],
          warning: { severity: 'throttle', code: 'linkedin-throttled' },
        },
      });
      const warnedRemaining = warnedWrites.at(-1).patch.scrapeWarnings;
      assert(JSON.stringify(codesFor(warnedRemaining, 'linkedin')) === JSON.stringify(['linkedin-blocked', 'linkedin-rate-limited', 'linkedin-throttled']),
        'a still-warned resolve keeps the source gates alongside the warning it returned');
      assert(warnedResumed.length === 0, 'scoring does not auto-resume while a preserved gate is still blocking');

      // Clean success is untouched: the source clears outright and scoring
      // resumes. That is the outcome this whole flow exists to reach.
      const cleanWrites = [];
      const cleanResumed = [];
      makeResolved({ hubRunId: 'run-1', warnings: [block, rateLimit, partial], writes: cleanWrites, resumed: cleanResumed })({
        detail: { hubId: 'hub-1', sourceId: 'linkedin', jobRunId: 'run-1', resolved: true, items: [], warning: null },
      });
      assert(codesFor(cleanWrites.at(-1).patch.scrapeWarnings, 'linkedin').length === 0,
        'a clean resolve still clears every warning for its source');
      assert(cleanResumed.length === 1, 'clearing the last gate still resumes scoring');
      return { gatesSurviveRestore: true, cleanResolveUnchanged: true };
    },
  },
];
