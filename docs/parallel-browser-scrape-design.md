# Parallel browser scrape — scope and design (DRAFT, 2026-11-22)

Status: scoped, not built. Nothing in this doc has been implemented.

## Goal

Run the four browser job platforms (Indeed, ZipRecruiter, Glassdoor, Google — `BROWSER_SCRAPE_ORDER` in `electron/ipc/jobs/sourceRules.js`) at the same time instead of one after another. Rate limits are per site, so in principle the run only needs to last as long as the slowest site.

Rough wall-clock figures, taken from the 2026-11-20 pacing measurements (not a timed full run):

| Site | Approx. time |
|---|---|
| Indeed (quarter pacing, ~590 jobs) | ~24 min |
| Glassdoor panels (10 per 5 min window, ~49 jobs) | ~25 min |
| ZipRecruiter (~90 jobs) | ~8 min |
| Google (3 queries) | ~2 min |
| **Sequential today** | **~60 min** |
| Indeed ∥ (trio in sequence) — phase 2 below | ~35 min |
| All four in parallel — phase 3 below | ~25 min |

**Correction (2026-11-22):** the table above is the wrong scale. A real run of yours took Glassdoor alone 7 h 43 min (11,837 listings reported), mostly waiting out its 10-panels-per-5-min limit. Parallel scraping can't shorten Glassdoor itself. It only saves the other sites' time, so get the real gain from the per-platform durations of a saved run before relying on any figure. The bigger lever is opening fewer Glassdoor panels: screen titles before a panel is opened (`partitionAlreadyReadJobs`, `manualScraper.js:1548`, is today's only pre-open filter; the AI role screen, `screenJobRolesByTitle`, runs only after the gather).

HTTP sources (LinkedIn guest, RemoteOK, WeWorkRemotely, USAJobs, Dice) already run concurrently with the browser phase (`Promise.all(gatherBranches)`, `electron/ipc/jobs/searchHandlers.js:1480`) and are out of scope.

## Why the browser sites are sequential today

1. **One profile folder.** Every scrape Chrome uses `getUserDataDir()` = `<userData>/browser-data` (`electron/ipc/stealthBrowser.js:44-60`, ~650 MB). Chrome OS-locks a profile folder per process (`SingletonLock` etc.).
2. **One lock and one reservation.** The whole browser phase runs inside one `withSharedProfileLock` hold (`withFreshManualScraperTelemetry`, `electron/ipc/jobs/collection.js:286`). On top of that, `sharedProfileReservation` (`stealthBrowser.js:184, 273-321`) is a single process-wide slot that Indeed holds for its whole scrape (`electron/extractors/indeedBrowser.js:1072`).
3. **A sequential loop.** `runBrowserSourcesInOrder` (`searchHandlers.js:1358-1424`) awaits each source before starting the next.
4. **Process-global scraper state that is only correct because of (2).** All of it lives in `electron/ipc/browser/manualScraper/scrapeState.js` and `scrapeTelemetry.js`:
   - `manualScraperTelemetry.paused` is one boolean. One platform's Pause would pause the others' pages.
   - `currentSourceId` is set by whichever event last named a source (`scrapeTelemetry.js:392-396`, whose comment says "Sources run strictly sequentially"). Activity beats, and the progress shown on each source card, are stamped from it, so concurrent sources would report on the wrong card.
   - `activitySinkState` is one renderer sink. The first `scrapeManualSources` call to finish clears it for the others.
   - `active`, `inFlight`, `browser` and `beat` describe one Chrome. The first teardown would report the profile as free while others still hold theirs.
   - `consoleLogs` and `networkErrors` carry no source, so they can't be attributed to a platform.
   - `resetManualSolveTracking` (`scrapeVerification.js:26`) clears one global Set.
5. **The shared singleton gets closed.** `scrapeManualSources` starts with an unconditional `closeStealthBrowser()` (`manualScraper.js:498`). `launchWithProfileLockRetry` also closes the shared singleton on any lock collision, whatever folder collided (`stealthBrowser.js:672-685`), except for the `headless-scrape` context.

## What is already safe

- **Staging writes.** `recordSourcePage` and `markSourceStatus` (`electron/ipc/jobRunStaging.js:1662, 1701`) go through a per-manifest FIFO path lock, and `atomicWriteJson` uses unique temp files. The HTTP branch already writes concurrently with the browser branch.
- **Per-source durability.** `markGatheredSourceTerminal` marks each source done as it finishes.
- **The post-gather step** reads `{ manualResults, indeedResult }` and keys results by sourceId.
  - To check during build: whether anything downstream depends on the order of `manualResults`.
- **State that is already per source or per call:** pace records in `scrapeTelemetry.js`, `scrapeMeasurement.js` (keyed by source), the locals in `pageReadiness.js` and `expandByNavigation.js`, and `jobsTelemetry.indeedSession`, which only Indeed writes.
- **Cookie encryption doesn't need the macOS keychain.** Every Puppeteer and native launch uses `--password-store=basic --use-mock-keychain` (`PUPPETEER_OSCRYPT_PARITY_ARGS`, `electron/ipc/browser/authWindows.js:259`). A `Cookies` DB copied while the folder is unlocked stays decryptable, provided the same Chrome build opens it.

## Options considered

- **A. One profile folder per platform.** This is the full fix. It needs profile seeding, a lock and a reservation per profile, and the login, Solve, recovery, verify and reset paths re-pointed per platform.
- **B. One Chrome, a tab per platform.** This saves only the profile half of the work. All of the process-global state in (4) still collides. It also reverses measured decisions:
  - a fresh Chrome per platform, so anti-bot "warmth" doesn't carry across sites (`manualScraper.js:500-506`)
  - Indeed on system Chrome while Google stays on its login build (`authWindows.js:711-719`)
  - Indeed's separate launcher

  It also keeps the shared profile held for the whole phase, so one crash kills all four sites and background tabs get throttled. **Rejected.**

## Recommended plan (phased)

### Phase 1 — make scraper state per source (no behaviour change)

Make every field listed in (4) per source, keyed by sourceId and carried on the platform bundle that `launchScrapePlatformBrowser` returns:

- `paused`
- the activity sink and its throttle
- `active`, `inFlight`, `browser`, `beat`
- console and network buffers, tagged with their source

Remove `currentSourceId` and have each overlay paint and beat carry its own sourceId. Snapshot `scrapeFingerprintPolicy(sourceId)` once at dispatch, because the measurement override is a module global (`scrapeBrowser.js:103-131`). The bug report then shows one scrape context per platform (`bugReport.js` and `bugReport/jobsSnapshot.js` consumers).

Keep **browser phases mutually exclusive between hubs**: one run-level "browser phase" mutex, held across the platform locks. Telemetry and manual-solve tracking then only need keying by source, not by run.

The suite stays green with sequential dispatch. This phase is useful on its own, because the bug report gets per-platform telemetry.

### Phase 2 — Indeed on its own profile, in parallel with the trio

Indeed is the cheapest platform to split off:

- It already has its own launcher and a `profileDir` parameter (`indeedBrowser.js:982, 1024`).
- It has no module-level state.
- It holds the reservation for its whole run anyway.

What phase 2 involves:

- `getPlatformUserDataDir('indeed')` → `browser-data-indeed`. Seed it once by copying `browser-data` while nothing holds it, skipping `Singleton*` and `lockfile`.
- A per-profile lock, `withProfileLock(profileId, …)` (one `createFifoLock` per id), and a per-profile reservation (a Map keyed by profile).
- Indeed's in-run scrape, resume (`recoveryHandlers.js:1742`), description retry, native challenge window (`authWindows.js:2298`) and login all use the Indeed profile.
- `runBrowserSourcesInOrder` becomes two concurrent branches, Indeed and "trio in order", run with `Promise.all` and sibling abort, matching the outer gather.
- Drop `scrapeManualSources`'s unconditional `closeStealthBrowser()` from the Indeed path. Make the collision-yield step close the singleton only when it holds the colliding folder.
- Let tab-restore cleanup (`tabRestoreState.js:21`) accept owned platform folders.
- Give each Chrome its own `--window-position` so the windows tile instead of stacking.
- Expected gain: ~60 → ~35 min. Only one seeded folder to keep in sync.

### Phase 3 — the trio on their own profiles

Repeat phase 2 for ZipRecruiter, Glassdoor and Google, then dispatch all four concurrently, each under its own lock.

Phase 3 also has to handle these:

- **Multi-lock acquisition order.** Locks are acquired shared first, then platforms in `BROWSER_SCRAPE_ORDER`, and only through one `acquireAll(ids)` helper. `clearBrowserSession` and the startup verify must hold every profile. The reentrancy guard is per lock instance (`asyncMutex.js:47`).
- **AppleScript native windows.** `nativeChromeReader.js:196-235` and `getNativeChromeTabs` (`authWindows.js:1083`) address a Chrome *app*, not a process. With several Chromes of the same build running, a native login or read can grab another profile's window. These flows need an "AppleScript native window" lock per app bundle, which every scrape on that build also takes. Otherwise native reads and logins must be kept out of a running scrape.
- **`_lastCaptchaHandoffAt`** (`authWindows.js:402, 2754`) is stamped only when the shared singleton was actually closed.
- **Consumers that stay on the shared profile and lock:** LinkedIn enrichment, the official-posting render, the guest liveness probes, all marketplace work, and the Dice/generic fetch.

## Decisions needed from you

1. **Where logins and Solves go after seeding.**
   - Recommended: login, verify and Solve for each of the four platforms use that platform's folder only.
   - The alternative, re-seeding from the shared folder before each scrape, risks Indeed's session being live in two folders at once. Indeed's PPID already drops after about 1.5–2.5 h, and if its refresh token rotates, two copies could sign each other out (unknown).
2. **"Continue with Google". ANSWERED 2026-11-22: yes, you sign in to these sites with Google.**
   - Every platform folder keeps its own copy of the SAME Google account's session. No extra Google accounts are needed.
   - Seeding copies that session in. If Google rejects a copied session, you sign in to Google once in that site's login window. That is a one-time cost per folder.
   - Indeed needs live Google cookies in its own folder, because its roughly 2 h step-up check sends you back through Google.
3. **Several Solve windows at once. ANSWERED 2026-11-22: OK, with the windows placed side by side.**
4. **Reset/clear. OPEN, under discussion.**
   - Today, Settings only offers "Reset Indeed session" (`resetPlatformSession('indeed')`, which clears Indeed-host cookies).
   - The all-profile `clear-browser-session` IPC deletes the whole `browser-data` folder. That includes the marketplace sign-ins and LinkedIn. Nothing in `src/` calls it.

## Risks to measure before shipping (per the pacing rule: measure, don't assume)

- **Challenge and 429 rates with four sites on one home IP at once.** The per-site pacing was measured one site at a time. Re-measure through `scrapeMeasurement.js`, and keep a setting to fall back to sequential dispatch.
- **Seeded-copy survival.** Do the Indeed session and any `.google.com` SID survive a filesystem copy under Chrome for Testing 147 with `--allow-browser-signin=false`? Live test.
- **Window focus.** Does CDP `Page.bringToFront` in one Chrome raise it above another Chrome where you are mid-challenge? Live test.
- **Resources.** Four headed Chromes at once, plus about 650 MB of disk per seeded folder (which can be trimmed after the copy).
- **Build drift.** Indeed falls back to Chrome for Testing when system Chrome is missing (`indeedBrowser.js:1045`), and ignores `CHROME_PATH` while the trio honours it. Each platform folder should be opened by exactly one build. Record the build per folder and refuse a mismatch, the way Google's session rule does.
- **Quit and Reset** must terminate every platform Chrome. Today nothing registers them outside the per-call bundle and Indeed's local `browser`.

## Tests that pin today's design

Run with `npm test`: test:unit, which needs the `--import ./scripts/test-stubs/register.mjs` stub, then test:scripts and test:resume-pdf. New test files must be added to `scripts/test-runner.js` by hand.

- Source-text slices end at the literal `const runBrowserSourcesInOrder` (`scripts/tests/job-run-staging.js:6516, 6527, 6548`).
- `withFreshManualScraperTelemetry` queueing behaviour is tested at `scripts/tests/job-diagnostics.js:12123-12141`. It must be rewritten: two hubs still don't erase each other's diagnostics, but platforms within a run run concurrently.
- The text of `withSharedProfileLock(...)` calls in recoveryHandlers, accounts and stealthBrowser is pinned, as are the `[browserOut, httpResults]` gather shape and the `markGatheredSourceTerminal` call text.
- Bug-report tests assume one scrape Chrome, one profile folder and one FIFO owner.
- Stale comments to rewrite: `searchHandlers.js:1189-1194, 1211-1214, 1307-1309`.
