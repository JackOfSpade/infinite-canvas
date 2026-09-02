# Handoff — "processing stuck" bug report fix

**Repo:** `/Users/jack/Desktop/My Apps/infinite-canvas`
**Branch:** `job-search-empirical-hardening`
**State:** uncommitted. `npm test` = **711 passed / 0 failed** (was 694 when this doc was first written). `npx eslint` clean. `npm run build` succeeds and signs.
**Do not commit or push** — Jack does version control manually.

---

## 1. The bug and the verified root cause

A Glassdoor job scrape sat at telemetry phase `page-extract` for 28s with **no telemetry, no log line, and no UI change**. The user filed "processing stuck" 24s after clicking Re-run.

**Root cause (verified by 38 adversarial agents, not assumed):** Glassdoor uses the `list-card-panel` description strategy. Its per-card loop (`electron/ipc/browser/manualScraper.js` ~3441–3964) calls `recordManualScraperTelemetry` **only on failure branches**; the single `card-walk` summary fires after the whole page with `{updateActive: false}`, so `active` stays pinned to `page-extract`. Pacing (`clickDelayMs: 4500`, `panelCooldownEvery: 8`, `panelCooldownMs: 12000`) is ~5–7s/card, so a **healthy** page-1 walk is ~170s of guaranteed silence.

Compounding it: manual browser sources (glassdoor/ziprecruiter/google) had **no mid-flight progress channel to the renderer at all**. `scrapeManualSources` receives `onResult` (fires once per source) and `stageOnPage` (disk-only crash-recovery write). `manualScraper.js` has no `.send`/`webContents` anywhere. Indeed and LinkedIn already had mid-flight emits; the rest did not.

**Net effect: a healthy walk and a wedged renderer were the same observation — silence.** That ambiguity, not a hang, is the defect.

### Two corrections to earlier hypotheses (do not regress these)
- `page.evaluate` is **not unbounded**. puppeteer-core 25.6.0 `Connection.js:45` defaults `protocolTimeout` to 180s. With `SITE_CHANGED_ABORT_THRESHOLD = 3` the worst case is ~9 min, not forever. Don't "fix" this with a shorter timeout without measuring — the silence was the problem, not the bound.
- The bug report's `Glassdoor: ema 9950ms /121` is **dead telemetry**. `recordReady`/`recordBodySize` (`scrapeBudget.js:135/165`) are written *only* by `browserPool.js:553/864/543/853`, and `browserPool.scrapeMultiple`'s only caller is `marketplace.js`. `jobs.js` and `manualScraper.js` import neither. I was misled by this number myself mid-debug; the report now labels it.

---

## 2. What changed (all 12 files)

### Core fix — `electron/ipc/browser/manualScraper.js`
The per-card progress line **already existed** at the right granularity ("Opening result card 4/30") — it was written to the visible Chrome overlay and never left the window.

- Import renamed: `updateOverlay as paintOverlay`. A **local `updateOverlay` wrapper** now calls `recordActivityBeat(state)` then delegates. All ~30 existing call sites become heartbeats for free, and the beat can never drift from what the window shows.
- New exported `recordActivityBeat(state)` / `setActivitySink(fn)` (exported for tests).
- Throttle: `ACTIVITY_SINK_MIN_INTERVAL_MS = 1000`, but a **status change always emits** (dropping those would reintroduce the frozen-card symptom).
- `withInFlight(label, detail, run)` records what is being awaited + `logger.warn` at `IN_FLIGHT_WARN_MS = 30_000`; wraps the `runExtractor` call. Clears in `finally` including on throw.
- New `page-extracted` telemetry row recording the extraction **outcome** (`ok`/`eval-error`/`site-changed`) — previously no row ever stated what an extraction returned.
- `ORIGIN_PHASES` set: run-origin rows (`source-start`, `query-start`, `location-*`, `reveal-finished`) retained in a separate `origins` ring so the 30-slot recency window can't evict the run's own identity.
- `manualScraperTelemetry` gains `origins`, `beat`, `inFlight`, `browser`, `currentSourceId`; accessor now **exposes `paused`** (it was tracked on every ~500ms poll and silently dropped).
- `browser` recorded at launch, set `running:false` in **both** the `disconnected` handler and `teardown()` (the report claims the profile lock is held from this, so it must not depend on an event a forced close might not deliver). Cleared at the run boundary in `resetManualScraperTelemetry`.
- `activitySink` cleared in the `finally` of `scrapeManualSources`.

### `electron/ipc/jobs.js`
`scrapeManualSources(...)` now gets `onActivity: (beat) => emitProgress({ nodeId, sourceId, status:'searching', count?, detail, url })`. Because `emitProgress` → `recordJobSourceProgress` restamps `jobsTelemetry.pipeline.ts`, this is also what keeps the report's liveness clock ticking during a browser walk. `count` is **omitted, not zeroed**, when absent so `mergeSourceProgress` keeps the last known value.

### `electron/ipc/bugReport.js`
- Imports `getManualScraperTelemetry` (**verified no import cycle** — `bugReport.js` loads cleanly).
- "Scrape/stealth browser" line: previously said `⚪ not running (profile lock free)` **during every manual scrape**, because it read only the stealthBrowser singleton that `scrapeManualSources` deliberately closes before launching its own Chrome on the same shared profile. Now reports the scraper's own process and says the lock is **held**.
- `search progress heartbeat` → relabelled `search stage/progress emit` (it moves on transitions, not a timer). Added `browser scrape activity beat` as a signal.
- `⚠️ possibly hung` no longer fires when the scrape is user-paused (`⏸️ paused by user` instead). Without the beat this flag fired on **every healthy Glassdoor walk**.
- Learned scrape budgets: each row now carries its write age; job-source keys are flagged `⚠️ not written by the job scraper` with a provenance note.

### `electron/ipc/bugReport/jobsSnapshot.js`
New liveness block in `### Active Browser Scrape`: paused banner, **Last activity beat** (with an explanation that a recent beat + stale phase = working normally), **⏳ Awaiting right now** with elapsed time and the 180s/3-strike explanation past 30s, and **Manual-scrape Chrome** status. Plus a retained "Source/query origin phases" list.

### Other verified defects fixed
- `electron/extractors/jobs.js` — Glassdoor extractor hardcoded `https://www.glassdoor.com` when absolutizing **relative** hrefs (lines ~141, ~167). A `.ca` walk produced a **mixed** `.com`/`.ca` set (absolute hrefs passed through unchanged), costing a redirect per open and breaking URL-keyed dedup. Now uses `gdOrigin` from `location.origin`.
- `electron/ipc/browser/authWindows.js` — `PLATFORM_COOKIE_DOMAINS.glassdoor` was `['.glassdoor.com']` only. `page.cookies(url)` returns only cookies applying to the urls asked for, so a `.ca` session read as "auth cookie ABSENT". Added 6 regional hosts (same shape as the existing Indeed multi-host note).
- `src/nodes/JobSearchNode.jsx` — 5 `errorMessage` writers raised the banner with **no log line** (`:1140`, `:1371`, `:1377`, runPipeline catch, `handleRerun`), which is exactly why this report showed "Try Again" clicked with no record of what failed. All now log. ~~The runPipeline catch also clears `filePath`~~ — **this line was wrong**; it described an abandoned approach. The catch writes only `hubState`/`errorMessage`/`isRateLimit`/`rerunOutcome`/`rerunNotice` and never touches `filePath`. The auto-restart loop (auto-start effect re-arming on `filePath` + `hubState:'empty'`, the pair that catch produces for a hub with zero `scoredJobs`) is real and is closed by the `autoStartedFilePathRef` one-shot latch instead — failures deliberately RETAIN the path so "Try Again" has something to re-run.
- `src/nodes/JobSourceCardNode.jsx` — `hasMeasuredProgress` now requires `progressTotal > 1`. A single-query source could only ever read `0/1` at a frozen 8%; an implied measurement that never moves reads as a stalled job.
- `src/nodes/jobsearch/JobSearchProcessingState.jsx` + `JobSearchNode.jsx` — new `activeSourceDetail` line so the hub shows the live step instead of only a spinner.

### Filter-code assessment (the question Jack asked)
**FULL was not enough**, but filter codes are subtractive-only — the fix was to *capture* the data (all of the above is in FULL automatically). Added one scoped code:

`src/utils/bugReportCodes.js` → **`STALL`** ("Stuck / Not Progressing"). **Trap already hit and fixed:** an unanchored `/hang/` matches "c-**hang**-ed", which kept every "viewport changed" line and made the code a no-op. The regex is word-bounded — **keep it that way**; there is a regression test pinning `kept < 12` on an 81-line noise sample.

### Tests — `scripts/tests/job-diagnostics.js` (+10), `scripts/test-dependencies.js`
Beat liveness/source inheritance; every distinct step reaches the UI but a 200-iteration same-status flood throttles to 1; cleared sink stops emits but keeps local beats; a **throwing sink cannot break the scrape**; origin rows survive 60 evicting events; `paused` exposed; Glassdoor extractor runs on both hosts and has no `.com` hardcode; STALL scoping + precision + FULL-unchanged.

> ⚠️ `scripts/tests/job-diagnostics.js` ends with `];`. Appending tests by script twice produced `},,` → *"Test registry invalid: contains an invalid test declaration"*. Check for `},,` if that error appears.

---

## 3. RESOLVED — the outstanding review, and what it turned up

The adversarial self-review (workflow `w2zkwncz5`, run `wf_62246c45-5f1`) **never produced results**: its journal holds four `started` rows and no `result` rows, and all four agent transcripts end in `[Request interrupted by user]`. There was nothing to read. It was re-done from scratch in the next session; the three residual doubts below were settled directly against the code.

1. **IPC volume on scroll sources — REFUTED.** `SCROLL_SOURCES` is `{google}` only, and both paints in `preloadContent` set a stable `activityKey: 'google-preload'`, so the count churn never reaches the status-change bypass — every beat after the first is governed by the 1s floor. The loop's own pacing (trusted-wheel reveal + `NAV_SETTLE_MS`) is ~3.5–5.5s/iteration, i.e. ~0.2–0.4 emits/sec, already under the throttle. `recordJobSourceProgress` folds consecutive like-for-like rows into `repeats` and hard-caps the array at 10.
2. **Ordering — REFUTED.** `terminalManualSourceIds` in `jobs.js` drops a beat for any source that already emitted its terminal result, and it is the only `onActivity` registration in the tree. Independently, every path after `onResult?.(result)` (source-finished telemetry → `teardownCurrent` → `finally`) emits no overlay paint, and every `updateOverlay` call site is awaited. Worth knowing: `mergeSourceProgress` has **no** status-regression guard, so this protection is single-layered — a future second beat call site would need the same check.
3. **`filePath: null` — moot.** See the correction in §2: the catch never clears it.

---

## 3b. Second round (bug report: "did this complete smoothly as expected?")

A 30-page Glassdoor run that finished `completed` with 782 rows. It did not complete cleanly, and the report said it did. Six confirmed defects, all fixed; `npm test` = **711 passed / 0 failed**, eslint clean.

1. **A recovered detail block reported zero cost.** Page 29's panel returned HTTP 502 on card 1; the walk stopped and deferred all 21 rows. `sourceDetailSkippedCards` only counts pages entered under an *already-armed* block, so the page that TRIGGERS one contributes nothing — and recovery on page 30 then cleared `firstPage` and reset `reprobes`. The line rendered as "detail enrichment was blocked by a source throttle; enrichment resumed", i.e. no loss at all. Added `unenrichedRows` (counted off `descriptionDeferredReason` on the rows themselves, so the triggering page is included), plus `everBlockedPage`/`reprobesTotal` which survive recovery. **When the counter is absent (older running main process) the report must NOT claim "every retained row still carries a description"** — that branch is gated on `unenrichedRows != null`.
2. **Unmarked truncation.** `warning.evidence` was cut by a bare `.slice(0, 220)`, ending a sentence mid-word ("…the scraper stopped befor") — reads as corruption, not truncation. Now uses `historyReportValue`, which appends `…`. Also: **`warning.suggestion` was never rendered by any report path**, dropping the one sentence saying what happened to the affected rows. It is 22 warnings' worth of dead payload; now rendered as `Suggested: …`.
3. **Origin rows were retained but never read.** `ORIGIN_PHASES` rows go to BOTH the 30-slot `events` ring and the `origins` ring — but `revealRuns`, `nationTierNotes` and `locationSkips` all filtered `events`. On this run the ring evicted `location-nation-tier-unenforced`, so `### Country scope not enforced` did not render at all even though the scraper had logged it. They now read a deduped `originPool` union (hoisted to the top of `buildJobsPipelineSnapshot` so the location section can use it too).
4. **The location section over-claimed.** `loc.perSource` is static pre-run metadata from the target string; it cannot see the resolved locId tier, so a nation-tier run still printed "Verified location filter". The runtime caveat now rides the same line as the claim. Note commit `72fd104` only fixed the *empty*-location branch of `describeLocationTreatment`; the branch used when the user types a bare country was untouched.
5. **The clipboard cap spent ~20% of its budget on all-confirming noise.** Drop order in `clipboardCap.js` is purely positional — six whole sections were dropped for being late in the concatenation. The biggest single consumer was 8 card-walk batches × 6 "expected → hit" lines that all matched, restating what `selection-mismatches 0` already says. An all-matching batch now collapses to one line that keeps the first→last physical span; a batch with any mismatch is never collapsed. **Measured: 14,623 → 4,495 chars (~10,100 saved, ~20% of the 50k cap).**
6. **Two lines that asserted more than was known.** "Run manifest: absent" / "Staging ledger: absent" is the *expected* state after a clean finish (there is no `done` stage — success deletes both sidecars), but printed bare it is indistinguishable from "staging silently never ran"; both now attribute the absence using the pipeline phase. And the funnel's "after dedup: 782 → 0 dropped" hid an entire earlier per-source `sourceJobKey` dedup layer that shed ~118 physical cards before "raw" was computed — now counted as `providerDuplicatesDropped` and stated on the per-source line.

### Follow-up audit: "did it scrape all the necessary jobs?" (12-agent adversarial pass)

Three of four conclusions survived refutation; one **refuted a bug introduced by fix 6 above** — worth reading before trusting any counter added in a hurry.

- **`completed` proves nothing about completeness.** It is the fall-through `return` of `resolveManualSourceStopReason` (manualScraper.js:321-364), reached when none of the ten specific terminal conditions fired. Glassdoor has `NEXT_PAGE_SELECTORS.glassdoor = null` and advances via `clickLoadMore`; when a board stops rendering its show-more control at its own result ceiling, the click returns `clicked:false` with `unhandled:null`, the loop breaks setting no flag, and the walk reports `completed` — **identical to a genuinely exhausted source**. `readClaimedResultTotal` hard-returns null for everything except ZipRecruiter (Glassdoor's own total is documented as untrustworthy), and the real end-of-list oracle (`revealEndOfListReached`, `exit: 'end-of-list'` vs `'plateau'`) is gated to `SCROLL_SOURCES` = google only. **The report now annotates `completed` as not-positive-evidence.**
- **The page-29 502 cost no relevant job.** The description-evidence gate is the last filter (jobs.js:4990), running after age → role → history, and every `kept` reassignment between them is count-preserving. Conservation closes it: 319 age-kept − 314 role − 1 history = 4 entering the gate, and `search.kept` recorded *after* the gate is 4, so it dropped zero. Deferred rows are also never written to seen-history (that happens only from the Job Board's displayed union, JobBoardNode.jsx:492-499), so the loss is recoverable on a re-run. Precise form: the 21 were eliminated by age, role, **or the single history drop**, and since `filterJobsByAge` KEEPS date-less rows, deferral can only ever bias toward keeping.
- **Region skew is unproven, not disproven.** Nothing enforced "United States": nation-tier locId is accepted and echoed but not filtered on, and the session ran on `www.glassdoor.ca`. But the 4/4 in-area tally covers only the 4 survivors (~0.5% of the pool); the 778 dropped rows' locations were never tallied. Note the staging sidecar that could settle it is **deleted on a clean finish** (`complete-job-run` → `clearRun` → `shell.trashItem`), so it is at best in the Trash.
- **REFUTED — the duplicate counter I added was wrong by ~110x.** `sourceDuplicateCards` incremented per re-encounter, but a load-more source re-scans its whole accumulated list every iteration, so it would have reported ~13,168 rather than 118. Replaced with a per-iteration delta (`sourcePhysicalCards += loadMoreSelector ? extracted.length - loadMorePrevCount : extracted.length`, reading `loadMorePrevCount` *before* the pageRows slice advances it) and reported as `sourcePhysicalCards - providerSeen.size`. **A counter placed inside a loop that re-reads a cumulative list measures re-reading, not events.**

### Third round — "fix all remaining" (12-agent enumerate + refute, then applied)

`npm test` = **715 passed / 0 failed**, eslint clean.

- **Every completeness-bearing stop reason is now annotated.** The flag chain covered 6 of 12 values; `blocked` had a bare "⚠️" glyph and no words. Added text for `blocked`, `user-done`, `detail-enrichment-failed`, `aborted`, `empty-page`, `end-of-results`, `age-window`, `no-new-jobs`, `data-stop`. Two traps the review caught: `user-done` **never means a user action** (a user stop sets `signal.aborted` → `aborted`; this is the abort-free exit — browser crash or repeated extractor failures — and because `earlyExit` is run-scoped it also kills every later source); and `age-window` must NOT claim "deeper pages exist" — the evidence is only that two consecutive served pages held nothing in-window.
- **A second false-completion route is closed.** `paginationRecoveries >= 2` broke the walk with no flag set, so a walk abandoned after an anti-bot challenge bounced it back to page 1 twice reported `completed`. New source-scoped flag → new `challenge-recovery-loop` stop reason, ranked ABOVE the data-driven stops (those all read as clean finishes and would hide it) and below `blocked`/`aborted`. Precedence is unit-tested in `fixtures-canvas.js`.
- **Latent `[object Object]`** — the manual walker adds STRINGS to a Set, the API path assigns an ARRAY OF `{query, stopReason}`; the bare `.join('/')` would render `[object Object]`. Normalized. **Do NOT also un-gate the `pagesWalked > 0` guard** (the review's own item 16) — that gate is the only thing keeping the API enum off this line, and un-gating renders `walked 0 pages` for LinkedIn, which pages internally. Refuted twice; deliberately not applied.
- **A stranded-card bug, found while declining to add a guard.** The proposed `mergeSourceProgress` status-regression guard **must not be added** — terminal→'searching' is shipping behaviour in four producers (mid-run LinkedIn enrichment, LinkedIn Solve re-fetch, post-Solve comp rescrape, cumulative bundle beat), one of whose comments says the re-entry is what cancels the card's dismiss timer, and a test already exercises it. But the underlying worry was already realized: a mid-Solve `searching` beat overwrites `detail`, and `JobSourceCardNode` latched its pre-Solve restore on the optimistic `detail: 'Solving…'` string — so a failing LinkedIn Solve skipped the restore and **stranded the card spinning with no warning and no Solve button**. Both restore branches now key on `isTerminalSourceStatus(prev.status)`. The non-guard is documented in `sourceProgress.js` and pinned by a test so the next reader does not "harden" it back.
- **Truncation sweep: 77 prose sites** now use a marker helper (`historyReportValue`, `truncateDiagnosticText`, or the new exported `clipReportText` for files with neither in scope). Identifiers — URLs, hashes, keys, selectors, paths, JSON blobs — deliberately keep their bare slice, because `…` on a value someone must match or copy corrupts it. Four markdown-table cells were **escape-then-slice**, where a cut between `\` and `|` leaves a dangling backslash that breaks the row; those are now clip-then-escape. All three decisions are test-pinned.
- **REFUTED, nothing applied — USAJobs `config-missing`.** The claim that the full-search path lacks a config-missing branch is false: it lives inside `fetchUSAJobs` and returns the same code/severity the refresh path synthesizes, so an unconfigured USAJobs already lands in "intentionally not queried", pinned by an existing test. The proposed `!apiKey || !email` guard was refuted twice — `apiExtractors.js` deliberately falls back to a default User-Agent when email is blank, so the change would make a supported configuration a silent skip and strand that fallback as dead code.

Not a defect, but load-bearing context: **the packaged build that produced that report predates the activity-beat work** (`recordActivityBeat` is uncommitted; `detail-block-reprobe` is in HEAD). None of §2's liveness fixes were exercised by that run, and none of the above will appear in a report until the app is rebuilt.

## 4. Verification commands

```bash
cd "/Users/jack/Desktop/My Apps/infinite-canvas"
npm test            # expect: 694 passed, 0 failed (uses the Electron stub; bare node fakes ~8 failures)
npx eslint electron/ src/ scripts/
npm run build
git diff --stat     # expect 12 files, ~590 insertions
```
