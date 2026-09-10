import { assert } from '../test-dependencies.js';
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
];
