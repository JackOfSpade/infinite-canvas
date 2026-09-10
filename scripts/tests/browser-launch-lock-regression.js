import { PLATFORM_AUTH_COOKIES, _resetLaunchCollisions, assert, clearAllSessionStatusCache, closeOwnedBrowserProcess, fs, generateMarkdown, getLaunchCollisions, getStatusCacheSync, path, recordLaunchCollision, reserveSharedProfile, toPuppeteerExtraAbortSignal, writeStatusCache } from '../test-dependencies.js';
import { EventEmitter } from 'node:events';
import merge from 'deepmerge';
import { formatAuthAttemptStatus } from '../../electron/ipc/bugReport.js';

// These tests pin the fix for: "Chrome launch blocked by the shared browser
// profile lock after 6 attempts" firing right after a successful native Indeed
// login. Root cause chain (see accounts.js / stealthBrowser.js / bugReport.js):
//   1. completeLoginWindowVerification's post-login auth-cookie survival check
//      calls readPlatformAuthCookieState -> getStealthBrowser(), which LAUNCHES
//      the retained headless singleton on the shared userDataDir and (unlike
//      openLoginWindow/resetPlatformSession) used to leave it running.
//   2. Chrome OS-locks a userDataDir to one process, so the very next browser
//      scrape launch on that profile burned its whole retry ladder.
//   3. A bug-report line meant to make this diagnosable read the wrong cache
//      key (`trace` instead of `lastTrace`) and printed "not recorded" even
//      when accounts.js had just observed the cookie.
// None of the three fixes are reachable through a real puppeteer.launch() in a
// pure test (that would mean faking a browser), so these tests pin the parts
// that ARE reachable without one: the source-level invariants that keep the
// singleton-launch context string from drifting into two independently-edited
// literals, and the cache-key wiring the bug-report diagnostic depends on.

const stealthBrowserSource = fs.readFileSync(path.resolve('electron/ipc/stealthBrowser.js'), 'utf8');
const accountsSource = fs.readFileSync(path.resolve('electron/ipc/accounts.js'), 'utf8');
const mainSource = fs.readFileSync(path.resolve('electron/main.js'), 'utf8');
const jobsSource = fs.readFileSync(path.resolve('electron/ipc/jobs.js'), 'utf8');
const manualScraperSource = fs.readFileSync(path.resolve('electron/ipc/browser/manualScraper.js'), 'utf8');
const backgroundScrapeSource = fs.readFileSync(path.resolve('electron/ipc/browser/backgroundScrapeBrowser.js'), 'utf8');
const authWindowsSource = fs.readFileSync(path.resolve('electron/ipc/browser/authWindows.js'), 'utf8');

export default [
  {
    name: 'puppeteer-extra launch abort signal survives its deepmerge with live event methods intact',
    run: () => {
      const controller = new AbortController();
      const bridge = toPuppeteerExtraAbortSignal(controller.signal);
      // This is the exact merge puppeteer-extra applies before it calls
      // puppeteer-core. Native AbortSignal becomes a method-less object here;
      // a function-shaped bridge must stay atomic and retain its live surface.
      const merged = merge({ args: [] }, { signal: bridge });
      assert(merged.signal === bridge, 'puppeteer-extra deepmerge must retain the bridge identity instead of cloning it');
      assert(typeof merged.signal.addEventListener === 'function' && typeof merged.signal.removeEventListener === 'function',
        'merged launch signal must retain addEventListener/removeEventListener for @puppeteer/browsers');
      assert(merged.signal.aborted === false, 'a fresh merged launch signal must be un-aborted');

      let abortEvents = 0;
      const listener = () => { abortEvents += 1; };
      merged.signal.addEventListener('abort', listener, { once: true });
      const reason = new Error('test launch cancellation');
      controller.abort(reason);
      assert(abortEvents === 1, 'the merged signal must forward native abort events exactly once');
      assert(merged.signal.aborted === true && merged.signal.reason === reason,
        'the merged bridge must expose live aborted/reason values after construction');
      merged.signal.removeEventListener('abort', listener);

      const preAborted = new AbortController();
      preAborted.abort('already cancelled');
      const preMerged = merge({ args: [] }, { signal: toPuppeteerExtraAbortSignal(preAborted.signal) });
      assert(preMerged.signal.aborted === true && preMerged.signal.reason === 'already cancelled',
        'a pre-aborted launch signal must remain observably aborted through puppeteer-extra deepmerge');
      return { identityPreserved: true, abortForwarded: true, preAbortVisible: true };
    },
  },
  {
    name: 'closeOwnedBrowserProcess waits for the owned Chrome child exit before resolving profile release',
    run: async () => {
      const proc = new EventEmitter();
      proc.exitCode = null;
      proc.signalCode = null;
      const signals = [];
      proc.kill = (signal) => { signals.push(signal); return true; };
      const browser = {
        process: () => proc,
        close: async () => {
          // Emit while close() is settling: the regression was subscribing
          // afterwards and missing this healthy exit.
          proc.exitCode = 0;
          proc.emit('exit', 0, null);
        },
      };
      const outcome = await closeOwnedBrowserProcess(browser, { label: 'test owned browser', gracefulMs: 5 });
      assert(outcome.exited === true && outcome.disposition === 'graceful-exit', `normal close must observe child exit — got ${JSON.stringify(outcome)}`);
      assert(signals.length === 0, `normal observed exit must not signal the child — got ${signals}`);
      return outcome;
    },
  },
  {
    name: 'closeOwnedBrowserProcess remains bounded when browser.close hangs and escalates the owned child',
    run: async () => {
      const proc = new EventEmitter();
      proc.exitCode = null;
      proc.signalCode = null;
      const signals = [];
      proc.kill = (signal) => {
        signals.push(signal);
        if (signal === 'SIGTERM') {
          proc.signalCode = signal;
          proc.emit('exit', null, signal);
        }
        return true;
      };
      const browser = {
        process: () => proc,
        // This promise never settles: completion must be governed by the
        // process deadline rather than a wedged CDP close promise.
        close: () => new Promise(() => {}),
      };
      const outcome = await closeOwnedBrowserProcess(browser, { label: 'hung close test', gracefulMs: 5 });
      assert(outcome.exited === true && outcome.disposition === 'sigterm-exit', `hung close must escalate and resolve — got ${JSON.stringify(outcome)}`);
      assert(signals.join(',') === 'SIGTERM', `hung close must send SIGTERM before any kill fallback — got ${signals}`);
      return outcome;
    },
  },
  {
    name: 'manual platform browsers use the profile-lock retry helper, suppress startup about:blank handoffs, and downgrade launch failure per source',
    run: () => {
      const launchStart = manualScraperSource.indexOf('async function launchScrapePlatformBrowser');
      const launchEnd = manualScraperSource.indexOf('// Clears the per-run browser diagnostic buffers', launchStart);
      assert(launchStart >= 0 && launchEnd > launchStart, 'manual platform launcher must be bounded before telemetry reset helpers');
      const launcher = manualScraperSource.slice(launchStart, launchEnd);
      assert(/launchWithProfileLockRetry\(prepareBackgroundScrapeLaunchOptions\(/.test(launcher),
        'manual platform launch must use the shared retry/diagnostic helper instead of raw puppeteer.launch');
      assert(!/puppeteer\.launch\(/.test(launcher), 'manual platform launcher must not bypass profile-lock retry with a raw Puppeteer launch');
      assert(/timeout:\s*30_000/.test(launcher), 'manual platform launch must have a bounded Puppeteer timeout');
      assert(/closeOwnedBrowserProcess\(browser,\s*\{\s*label: 'Manual browser teardown'/.test(launcher),
        'manual teardown must wait through owned-process close/escalation before yielding the profile');
      assert(/--no-startup-window/.test(backgroundScrapeSource) && /ignoreDefaultArgs/.test(backgroundScrapeSource),
        'background manual launches must retain macOS no-startup-window/about:blank suppression');

      const sourceLoop = manualScraperSource.slice(manualScraperSource.indexOf('for (let si = 0;'), manualScraperSource.indexOf('  } finally {', manualScraperSource.indexOf('for (let si = 0;')));
      assert(/stopReason: 'browser-launch-failed'/.test(sourceLoop)
        && /isProfileLockCollision\(error\)/.test(sourceLoop)
        && /code: profileLocked \? 'browser-profile-locked' : 'browser-launch-failed'/.test(sourceLoop)
        && /continue;/.test(sourceLoop),
      'manual source launch failures must distinguish profile locks from generic launch errors and continue sibling sources');
      return { launcher: 'retry+timeout', teardown: 'process-exit', failure: 'source-block' };
    },
  },
  {
    name: 'all profile launches share the bounded late-result cleanup and disconnected singleton teardown uses it',
    run: () => {
      const retryStart = stealthBrowserSource.indexOf('export async function launchWithProfileLockRetry');
      const retryEnd = stealthBrowserSource.indexOf('export async function getStealthBrowser', retryStart);
      const retry = stealthBrowserSource.slice(retryStart, retryEnd);
      assert(retry.includes('CHROME_LAUNCH_DEADLINE_MS') && retry.includes('late launch cleanup')
        && retry.includes('closeOwnedBrowserProcess(browser')
        && retry.includes('signal: toPuppeteerExtraAbortSignal(launchSignal)')
        && retry.includes('launchDeadline.abort(error)')
        && retry.includes('waitForProfileReleaseAfterLaunchAbort(launchOptions.userDataDir)'),
      'profile launch retry must give Puppeteer a deepmerge-safe deadline signal, observe profile-lock release, and close a late browser result');
      assert(retry.includes('let callerAborted = false;')
        && retry.includes("callerSignal?.addEventListener?.('abort', onCallerAbort, { once: true })")
        && retry.includes('timedOut || callerAborted || callerSignal?.aborted')
        && retry.includes("callerSignal?.removeEventListener?.('abort', onCallerAbort)"),
      'caller cancellation must mark a launch abandoned, close any late Browser, and wait for profile release before the FIFO can advance');
      const browserStart = stealthBrowserSource.indexOf('export async function getStealthBrowser');
      const browserEnd = stealthBrowserSource.indexOf('export async function createStealthPage', browserStart);
      const singleton = stealthBrowserSource.slice(browserStart, browserEnd);
      assert(singleton.includes("label: 'Disconnected shared browser process'")
        && singleton.includes('closeOwnedBrowserProcess(deadInstance'),
      'a disconnected singleton must use bounded owned-process cleanup, not SIGTERM plus a fixed sleep');
      return { launchDeadline: 'canonical', orphanCleanup: 'bounded' };
    },
  },
  {
    name: 'captcha setup failure closes its owned Chrome before releasing profile admission guards',
    run: () => {
      const marker = authWindowsSource.indexOf('// Same robust close as openLoginWindow');
      const close = authWindowsSource.indexOf("await closeLoginBrowserSafely(captchaBrowser, 'Captcha-resolve window')", marker);
      const releaseProfile = authWindowsSource.indexOf('releaseProfileReservation?.();', marker);
      const releasePool = authWindowsSource.indexOf('releaseBrowserPoolPause?.();', marker);
      assert(marker >= 0 && close > marker && releaseProfile > close && releasePool > close,
        'captcha setup failure must retain both admission guards until the owned Chrome close/process-exit path settles');
      return { closeBeforeProfileRelease: true, closeBeforePoolRelease: true };
    },
  },
  {
    name: 'auth-gated work waits for its platform startup verification instead of reading a transient false cache',
    run: () => {
      const scheduleIndex = mainSource.indexOf('schedulePlatformVerification();');
      const timerIndex = mainSource.indexOf('setTimeout(() => {', scheduleIndex);
      assert(scheduleIndex >= 0 && timerIndex > scheduleIndex,
        'main must mark platform verification pending before the renderer-mount delay, closing the pre-timer auth-cache race');

      const jobHandlerStart = accountsSource.indexOf("handleSafe('check-job-platform-auth'");
      const jobHandlerEnd = accountsSource.indexOf('\n  });', jobHandlerStart);
      const jobHandler = accountsSource.slice(jobHandlerStart, jobHandlerEnd);
      assert(jobHandler.indexOf('await waitForPendingPlatformVerification([platformId]);') >= 0
        && jobHandler.indexOf('await waitForPendingPlatformVerification([platformId]);') < jobHandler.indexOf('const cache = await readStatusCache();'),
      'the renderer-facing job auth check must await this platform before consulting its cache');

      const sellHandlerStart = accountsSource.indexOf("handleSafe('check-sell-monitor-auth'");
      const sellHandlerEnd = accountsSource.indexOf('\n  });', sellHandlerStart);
      const sellHandler = accountsSource.slice(sellHandlerStart, sellHandlerEnd);
      assert(sellHandler.indexOf('await waitForPendingPlatformVerification([platformId]);') >= 0
        && sellHandler.indexOf('await waitForPendingPlatformVerification([platformId]);') < sellHandler.indexOf('const cache = await readStatusCache();'),
      'sell-side auth checks share the same startup race and must wait before reading their cache too');

      const backendWait = jobsSource.indexOf("preflight('await pending startup session verification'");
      const backendCache = jobsSource.indexOf("preflight('read session status cache'", backendWait);
      assert(backendWait >= 0 && backendCache > backendWait,
        'the main-process job search gate must independently wait, so a stale renderer cannot bypass the fix');
      return { scheduledBeforeDelay: true, rendererGateWaits: true, backendGateWaits: true };
    },
  },
  {
    name: 'HEADLESS_SCRAPE_LAUNCH_CONTEXT: the singleton-yield guard and getStealthBrowser\'s own launch use the identical constant, not two literals that can drift',
    run: () => {
      // Exactly one definition. If a second `const HEADLESS_SCRAPE_LAUNCH_CONTEXT =`
      // ever appeared (e.g. a merge duplicating the module), the two could disagree
      // and this test would still pass against whichever wins by declaration order —
      // so also require the literal 'headless-scrape' appears NOWHERE else in the
      // file, which is the only way a drifted call site (hardcoding the string
      // instead of referencing the constant) could hide.
      const defMatches = [...stealthBrowserSource.matchAll(/const HEADLESS_SCRAPE_LAUNCH_CONTEXT = '([^']+)';/g)];
      assert(defMatches.length === 1, `expected exactly one HEADLESS_SCRAPE_LAUNCH_CONTEXT definition, found ${defMatches.length}`);
      const contextValue = defMatches[0][1];
      assert(contextValue === 'headless-scrape', `unexpected singleton launch-context value: ${contextValue}`);

      const literalOccurrences = [...stealthBrowserSource.matchAll(/'headless-scrape'/g)];
      assert(literalOccurrences.length === 1,
        `the raw string literal 'headless-scrape' must appear only in the constant definition — found ${literalOccurrences.length} occurrence(s), meaning some caller may have hardcoded it instead of referencing HEADLESS_SCRAPE_LAUNCH_CONTEXT`);

      // The retry-loop guard (launchWithProfileLockRetry) that decides whether to
      // ask the retained singleton to yield must reference the SAME constant.
      const retryFnStart = stealthBrowserSource.indexOf('export async function launchWithProfileLockRetry');
      const retryFnEnd = stealthBrowserSource.indexOf('export async function getStealthBrowser', retryFnStart);
      assert(retryFnStart !== -1 && retryFnEnd !== -1 && retryFnEnd > retryFnStart, 'launchWithProfileLockRetry must be defined before getStealthBrowser');
      const retryFnSource = stealthBrowserSource.slice(retryFnStart, retryFnEnd);
      assert(/context !== HEADLESS_SCRAPE_LAUNCH_CONTEXT/.test(retryFnSource),
        'the singleton-yield guard must skip recursion specifically for HEADLESS_SCRAPE_LAUNCH_CONTEXT — closing "the singleton" mid-launch of itself would wedge or use-after-close');

      // getStealthBrowser's own call into launchWithProfileLockRetry must pass the
      // constant BY REFERENCE (the identifier), not a re-typed 'headless-scrape'
      // literal — otherwise a rename of the constant's value silently stops
      // matching this call site and the guard above never fires for it again.
      const getBrowserFnStart = stealthBrowserSource.indexOf('export async function getStealthBrowser');
      const getBrowserFnEnd = stealthBrowserSource.indexOf('export async function createStealthPage', getBrowserFnStart);
      assert(getBrowserFnStart !== -1 && getBrowserFnEnd !== -1 && getBrowserFnEnd > getBrowserFnStart, 'getStealthBrowser must be defined before createStealthPage');
      const getBrowserFnSource = stealthBrowserSource.slice(getBrowserFnStart, getBrowserFnEnd);
      // Match the identifier, not the punctuation around it — the invariant is
      // "this call site references the constant", and pinning the exact argument
      // formatting would fail on a reflow that changed nothing that matters.
      assert(/\bHEADLESS_SCRAPE_LAUNCH_CONTEXT\b/.test(getBrowserFnSource),
        "getStealthBrowser's launchWithProfileLockRetry call must pass the HEADLESS_SCRAPE_LAUNCH_CONTEXT identifier itself, not a re-typed string literal");

      return { contextValue };
    },
  },
{
    name: 'completeLoginWindowVerification only closes the retained singleton when its OWN cookie-survival check woke it',
    run: () => {
      // This is the regression's actual side effect: a post-login check that
      // touches getStealthBrowser() must leave the shared profile exactly as it
      // found it. Pinned via source (the function is module-private) because
      // exercising it for real means driving readPlatformAuthCookieState through
      // an actual Puppeteer launch — not a pure test.
      const start = accountsSource.indexOf('async function completeLoginWindowVerification');
      const end = accountsSource.indexOf('export async function verifyAllPlatforms', start);
      assert(start !== -1 && end !== -1 && end > start, 'completeLoginWindowVerification must be defined before verifyAllPlatforms');
      const fnSource = accountsSource.slice(start, end);

      assert(/const stealthBefore = getStealthBrowserInfo\(\);/.test(fnSource),
        'must snapshot the singleton BEFORE the cookie-survival check touches it');
      // Identity, not a bare boolean. A `connected` flag sampled before the read
      // goes stale the moment any concurrent path (notably
      // launchWithProfileLockRetry's on-collision yield) tears the browser down:
      // our read then relaunches a NEW generation that this check alone caused
      // to exist, while `wasRunning === true` concludes "someone else's, leave
      // it" — re-creating the reported profile-lock hang. Comparing generation
      // is what makes "did WE start this process" answerable at all.
      assert(/stealthAfter\.generation !== stealthBefore\.generation/.test(fnSource),
        'the close decision must compare the singleton GENERATION across the check, not just a connected boolean that can go stale');
      assert(/!stealthBefore\.connected \|\|/.test(fnSource),
        'the close decision must still cover the plain case: it was not running before and is now');
      // And it must never yank a browser another caller is mid-operation on —
      // getBrowserSessionResetBlocker is the existing "is it safe to close" seam
      // (held reservation / in-flight launch / live pages).
      assert(/await getBrowserSessionResetBlocker\(\)/.test(fnSource),
        'the close must be skipped when a concurrent caller is using the shared browser');
      assert(/await closeStealthBrowser\(false\);/.test(fnSource.slice(fnSource.indexOf('const stealthAfter'))),
        'the yield-if-we-started-it branch must actually release the shared profile');

      // The close decision must live in a `finally` so it runs on every outcome of
      // the cookie check (present / absent / unrunnable) — not tacked onto one
      // branch, which would leave the singleton alive on the branches that forgot it.
      const finallyIndex = fnSource.indexOf('} finally {');
      const closeIndex = fnSource.indexOf('const stealthAfter = getStealthBrowserInfo();');
      assert(finallyIndex !== -1 && closeIndex > finallyIndex,
        'the yield-if-we-woke-it close must live inside a finally block, not one conditional branch of the cookie check');

      return { ok: true };
    },
  },
{
    name: 'startup verification releases only the idle shared-browser generation that it started',
    run: () => {
      // Startup verification's pages are individually closed by fetchHtmlClean.
      // Pin the remaining ownership rule here, without requiring a real Chrome:
      // it must yield the process-level profile lock only if its generation was
      // created during this run, and must use the normal live-page/reservation
      // blocker before closing.
      const start = accountsSource.indexOf('export async function verifyAllPlatforms');
      const end = accountsSource.indexOf('// ── Single-flight login dedup', start);
      assert(start !== -1 && end !== -1 && end > start, 'verifyAllPlatforms must be bounded before login-flow code');
      const fnSource = accountsSource.slice(start, end);

      const before = fnSource.indexOf('const stealthBefore = getStealthBrowserInfo();');
      const workers = fnSource.indexOf('await Promise.all(workers);');
      const after = fnSource.indexOf('const stealthAfter = getStealthBrowserInfo();');
      const blocker = fnSource.indexOf('await getBrowserSessionResetBlocker();', after);
      const close = fnSource.indexOf('await closeStealthBrowser(false);', blocker);
      assert(before >= 0 && workers > before && after > workers,
        'startup verification must compare shared-browser identity from before the worker pool with identity after all verifier pages finish');
      assert(/stealthAfter\.generation !== stealthBefore\.generation/.test(fnSource.slice(after)),
        'startup release must compare generation, not a stale connected boolean');
      assert(/!stealthBefore\.connected \|\|/.test(fnSource.slice(after)),
        'startup release must cover the normal case where startup launched the singleton from stopped');
      assert(blocker > after && close > blocker,
        'startup release must check for live work/reservations before closing its idle browser');
      assert(fnSource.includes("[Accounts] Released idle shared browser after startup verify"),
        'startup profile release must be logged for future diagnostics');
      return { ownership: 'generation-scoped', release: 'idle-only' };
    },
  },
{
    name: 'bug report "Auth cookie present on disk" reads writeStatusCache\'s lastTrace field, not a stale trace key',
    run: () => {
      // accounts.js writes `{ connected, ts, ...extras }` — passing lastTrace as an
      // extra is what actually lands the value under `.lastTrace`, exactly as
      // completeLoginWindowVerification and listingStatusCheck/marketplace.js's
      // writeStatusCache(..., { lastTrace }) calls do it.
      assert(Object.keys(getStatusCacheSync()).length === 0, 'session status cache must start empty for this test to be conclusive');
      try {
        writeStatusCache('indeed', true, { lastReason: 'native login verified', lastTrace: { authCookiePresent: true, authCookieNames: PLATFORM_AUTH_COOKIES.indeed } });
        writeStatusCache('glassdoor', false, { lastReason: 'cookie absent', lastTrace: { authCookiePresent: false, authCookieNames: PLATFORM_AUTH_COOKIES.glassdoor } });
        writeStatusCache('reverb', true, { lastReason: 'check could not run', lastTrace: { authCookiePresent: null, authCookieNames: PLATFORM_AUTH_COOKIES.reverb } });
        // Regression case: extras use the WRONG key (`trace`, matching the reported
        // bug) instead of `lastTrace`. A correct reader must treat this exactly like
        // a platform whose check never ran this process — "not recorded" — never
        // fall back to reading `.trace` and surface a stale/wrong value.
        writeStatusCache('linkedin', true, { lastReason: 'native login verified', trace: { authCookiePresent: true, authCookieNames: PLATFORM_AUTH_COOKIES.linkedin } });
        // 'facebook' and 'aptdeco' are left untouched: platforms with a known auth
        // cookie whose check never ran this process at all.

        const report = generateMarkdown({
          description: 'Auth cookie cache-key regression fixture.',
          nodes: [], edges: [], drawings: [], frontEndState: {},
          nodeInternals: [], nodeComponentStates: [], eventLogs: [],
          filterCode: 'PERSIST',
        }).markdown;

        assert(report.includes('## Session Persistence Diagnostics'), 'PERSIST report must include the session persistence section this line lives in');
        assert(report.includes(`  - \`indeed\` (\`${PLATFORM_AUTH_COOKIES.indeed.join(',')}\`): present`),
          'a platform whose lastTrace.authCookiePresent is true must print "present"');
        assert(report.includes(`  - \`glassdoor\` (\`${PLATFORM_AUTH_COOKIES.glassdoor.join(',')}\`): ABSENT`),
          'a platform whose lastTrace.authCookiePresent is false must print "ABSENT", not be silently omitted');
        assert(report.includes(`  - \`reverb\` (\`${PLATFORM_AUTH_COOKIES.reverb.join(',')}\`): not observed — the on-disk read could not run`),
          'an explicit null (check ran, could not read disk) must be distinguished from "never checked"');
        assert(report.includes(`  - \`facebook\` (\`${PLATFORM_AUTH_COOKIES.facebook.join(',')}\`): not recorded`),
          'a platform never checked this process must print "not recorded"');
        assert(report.includes(`  - \`aptdeco\` (\`${PLATFORM_AUTH_COOKIES.aptdeco.join(',')}\`): not recorded`),
          'a platform never checked this process must print "not recorded"');
        // The regression pin: linkedin's cache entry HAS a cookie observation, but
        // filed under the wrong key. The fixed reader must not find it.
        assert(report.includes(`  - \`linkedin\` (\`${PLATFORM_AUTH_COOKIES.linkedin.join(',')}\`): not recorded`),
          'a cache entry recorded under the legacy `trace` key (not `lastTrace`) must read as "not recorded", proving the report reads lastTrace and not trace');
        assert(!/linkedin.*: present/.test(report), 'the legacy `trace`-keyed entry must never be misread as a confirmed "present"');

        return { platformsChecked: 6 };
      } finally {
        clearAllSessionStatusCache();
      }
    },
  },
{
    // A sibling fix threaded `askedSingletonToYield` through recordLaunchCollision
    // as the fact separating "our own idle singleton held the lock (and was asked
    // to step aside)" from "something else held it and was never asked to". It is
    // a genuine tri-state (true / false / null-unreported) — browserLaunchTelemetry.js
    // deliberately writes `askedSingletonToYield === true ? true : askedSingletonToYield
    // === false ? false : null` rather than `!!value`, specifically so a caller
    // passing anything other than a real boolean observation (a bug, or a value that
    // merely happens to be truthy) is recorded as "not reported" rather than silently
    // coerced into an asserted "yes". This test pins that coercion resistance — the
    // property the collision line's report rendering depends on to never guess.
    name: 'browserLaunchTelemetry.recordLaunchCollision: askedSingletonToYield is stored as a genuine tri-state, never coerced from a truthy non-boolean',
    run: () => {
      _resetLaunchCollisions();
      try {
        recordLaunchCollision({ context: 'headless-scrape', attempts: 1, recovered: true, askedSingletonToYield: true });
        recordLaunchCollision({ context: 'headless-scrape', attempts: 1, recovered: true, askedSingletonToYield: false });
        recordLaunchCollision({ context: 'headless-scrape', attempts: 1, recovered: true }); // never reported
        // A caller bug that passes a truthy-but-non-boolean value (e.g. a string)
        // must NOT be recorded as an observed "yes" — only a strict `true` counts.
        recordLaunchCollision({ context: 'headless-scrape', attempts: 1, recovered: true, askedSingletonToYield: 'yes' });

        const events = getLaunchCollisions().events;
        assert(events.length === 4, `expected 4 recorded events, got ${events.length}`);
        assert(events[0].askedSingletonToYield === true, 'explicit true must round-trip as true');
        assert(events[1].askedSingletonToYield === false, 'explicit false must round-trip as false');
        assert(events[2].askedSingletonToYield === null, 'an unreported call must record null, not false (false would assert "we know it did not ask")');
        assert(events[3].askedSingletonToYield === null,
          'a truthy non-boolean value must be treated as "not reported" (null), never coerced into an asserted true — that would be a guess dressed up as an observation');

        return { events: events.length };
      } finally {
        _resetLaunchCollisions();
      }
    },
  },
{
    // The rendered "Shared-profile launch collisions" line is what a user actually
    // sees in a bug report — the record shape pinned above is only useful if this
    // renders it faithfully. Exercises the REAL bugReport.js code path (not a
    // source-text pin): seed browserLaunchTelemetry's real singleton state via
    // recordLaunchCollision, then read the line back out of generateMarkdown's
    // actual output. A live shared-profile reservation is used only to satisfy the
    // section's own gate (entries.length > 0 || profileReservation) — the same
    // technique the pre-existing "Bug report preserves failed diagnostic sections
    // and profile reservations" test (job-diagnostics.js) uses, so this never has
    // to fake auth-window state to get the section to render.
    name: 'bug report "Shared-profile launch collisions" line renders counts + the last event\'s host/recovery/singleton-yield state, and never asserts a yield either way when unreported',
    run: () => {
      const release = reserveSharedProfile('browser-launch-lock-regression-test');
      try {
        // Case 1: recovered, and the singleton WAS asked to yield this attempt.
        _resetLaunchCollisions();
        recordLaunchCollision({
          context: 'headless-scrape', url: 'https://www.ebay.com/sch/i.html?_from=abc', attempts: 3,
          recovered: true, error: 'already running for x', ts: Date.now(), askedSingletonToYield: true,
        });
        let report = generateMarkdown({
          description: 'Shared-profile collision line fixture (asked to yield).',
          nodes: [], edges: [], drawings: [], frontEndState: {},
          nodeInternals: [], nodeComponentStates: [], eventLogs: [],
          filterCode: 'PERSIST',
        }).markdown;
        assert(report.includes('## Auth Window Diagnostics'), 'PERSIST report must include the Auth Window Diagnostics section this line lives in');
        assert(report.includes('⚠️ Shared-profile launch collisions: **1** total, 1 auto-recovered.'),
          'total/recovered counts must reflect the recorded events');
        assert(/Last: `headless-scrape` www\.ebay\.com — auto-recovered after 3 attempt\(s\), \d+s ago\./.test(report),
          'last-event line must name the context, the URL\'s host only, the recovery outcome and attempt count');
        assert(report.includes('The retained singleton was asked to yield during this attempt.'),
          'askedSingletonToYield === true must render the asked-to-yield sentence');
        assert(!report.includes('was NOT asked to yield'), 'must not ALSO render the not-asked sentence for the same event');

        // Case 2: NOT recovered, and the singleton was NOT asked to yield (an
        // observed "no", e.g. a visible window held it — distinct from "unknown").
        _resetLaunchCollisions();
        recordLaunchCollision({
          context: 'captcha-resolve-window', url: 'https://www.glassdoor.com/Job/x', attempts: 6,
          recovered: false, error: 'Opening in existing browser session', ts: Date.now(), askedSingletonToYield: false,
        });
        report = generateMarkdown({
          description: 'Shared-profile collision line fixture (not asked to yield).',
          nodes: [], edges: [], drawings: [], frontEndState: {},
          nodeInternals: [], nodeComponentStates: [], eventLogs: [],
          filterCode: 'PERSIST',
        }).markdown;
        assert(report.includes('⚠️ Shared-profile launch collisions: **1** total, 0 auto-recovered.'),
          'an un-recovered event must not be counted as auto-recovered');
        assert(/Last: `captcha-resolve-window` www\.glassdoor\.com — NOT recovered \(6 attempt\(s\)\), \d+s ago\./.test(report),
          'an un-recovered last event must say NOT recovered with its attempt count, not be misread as recovered');
        assert(report.includes('The retained singleton was NOT asked to yield during this attempt (already yielded, not running, or this context can\'t ask itself).'),
          'askedSingletonToYield === false must render the explicit not-asked sentence');
        assert(!report.includes('was asked to yield during this attempt.'), 'must not ALSO render the asked-to-yield sentence for the same event');

        // Case 3 (the property this whole test protects): askedSingletonToYield was
        // never reported for this event (no url, no ts either, exercising the "no
        // host"/"no age" branches too). The report must render NEITHER yield
        // sentence — asserting either one here would be exactly the silent
        // guess-instead-of-observation regression this diagnostic exists to avoid.
        _resetLaunchCollisions();
        recordLaunchCollision({ context: 'headless-scrape', attempts: 1, recovered: false, error: 'The browser is already running for x' });
        report = generateMarkdown({
          description: 'Shared-profile collision line fixture (yield state unreported).',
          nodes: [], edges: [], drawings: [], frontEndState: {},
          nodeInternals: [], nodeComponentStates: [], eventLogs: [],
          filterCode: 'PERSIST',
        }).markdown;
        assert(report.includes('Last: `headless-scrape` — NOT recovered (1 attempt(s)).'),
          'with no url and no ts, the last-event line must omit the host and age segments entirely rather than print an empty/placeholder one');
        assert(!report.includes('The retained singleton was asked to yield during this attempt.')
          && !report.includes('The retained singleton was NOT asked to yield during this attempt'),
          'when askedSingletonToYield was never reported (null), the report must assert neither "asked" nor "not asked" — either would be a guess');

        return { casesChecked: 3 };
      } finally {
        _resetLaunchCollisions();
        release();
      }
    },
  },
{
    // The singleton-activity snapshot (stealthBrowser.js's `_lastActivitySnapshot`)
    // exists specifically so a bug report can tell "our idle browser held the
    // profile lock and did nothing" apart from "it's mid-scrape" — but it only has
    // an honest observation once something has actually inspected browser.pages()
    // for the CURRENT generation. No test in this suite launches a real Chrome
    // (that would defeat the point of a pure test), so the module-level browser
    // singleton stays in its true never-launched state for the whole run — the
    // one activity state genuinely reachable without faking a browser. That makes
    // this a real behavioural assertion, not a source-text pin: it reads
    // bugReport.js's actual formatStealthBrowserActivity output through
    // generateMarkdown, pinning that "never observed" renders as "not observed"
    // and never collapses into the "idle — 0 live pages" text, which asserts an
    // observation (zero pages, just now) that was never actually made.
    name: 'bug report "Current shared browser" activity renders "not observed" for a never-launched singleton, never guessing "idle"',
    run: () => {
      const report = generateMarkdown({
        description: 'Singleton activity fixture.',
        nodes: [], edges: [], drawings: [], frontEndState: {},
        nodeInternals: [], nodeComponentStates: [], eventLogs: [],
        filterCode: 'PERSIST',
      }).markdown;
      assert(report.includes('## Session Persistence Diagnostics'), 'PERSIST report must include the section this line lives in');
      assert(report.includes('- Current shared browser: stopped · generation 0 · executable `(not launched this process)` · activity: not observed'),
        'a never-launched singleton must render connected=stopped, generation 0, no executable, and activity "not observed"');
      assert(!report.includes('activity: idle — 0 live pages'),
        'must never render the "idle, 0 live pages" text for a browser that was never inspected — that asserts a live observation which was never taken');
      return { ok: true };
    },
  },
  {
    name: 'captcha-resolve history reports challenge clearance rather than a failed login',
    run: () => {
      assert(formatAuthAttemptStatus({
        mode: 'captcha-resolve', platformId: 'captcha:www.google.com', result: 'cleared', loginDetected: false,
      }) === '✅ challenge cleared',
      'a cleared captcha-resolve window must not fall through to the login-only "NOT detected" status');
      assert(formatAuthAttemptStatus({
        mode: 'captcha-resolve', platformId: 'captcha:www.google.com', result: 'timeout', loginDetected: false,
      }) === 'challenge result=timeout',
      'an unresolved captcha must report its challenge outcome without asserting anything about login');
      assert(formatAuthAttemptStatus({
        mode: 'puppeteer-visible', platformId: 'glassdoor', result: 'auto-detected', loginDetected: true, loginSignal: 'auth-cookie',
      }) === '✅ detected (auth-cookie)',
      'ordinary login attempts retain their authentication status rendering');
      return { captchaStatus: 'cleared' };
    },
  },
];
