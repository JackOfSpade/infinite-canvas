# One official-posting finder: folding the career-site location lookup into `resolveOfficialPostings`

Status: **plan only, not built** (written 2026-11-10). Rule behind it: every "find the employer's own posting" need goes through one finder, `resolveOfficialPostings` in `electron/ipc/officialPostingService.js`.

## What exists today

There are two separate searches for the same thing, the employer's own posting of a job.

1. **The official-posting finder.** `resolveOfficialPostings(jobs, { callRaw, callMatch, store, ... })` (`officialPostingService.js:399`) runs research, downloads or renders the leads, has two judges compare them, and stores an `officialPosting` record. That record carries `level`, `outcome`, `employer`, `title`, `location {display, workMode, remote, remoteCountry, remoteRegion}`, `salary {text, provenance}`, `sourceUrl`, `officialApplyUrl` and the full description. The posting refresh (`officialPostingRefresh.js`) and bundle generation (`officialPostingGeneration.js`) both call it. Results are cached in the official-posting store.
2. **The career-site location lookup.** `electron/ipc/jobLocationLookup.js` asks one batched, grounded question per run: "find the SAME posting on the employer's own careers site or its applicant-tracking page" and return only its work location.
   - **Caller:** `researchCompensationAssessments` in `electron/ipc/jobs.js`. Its pre-pass at around line 10280 builds requests with `buildJobLocationLookupRequest`, keeps at most 12 with `selectLookupRequests`, runs `runJobLocationLookup`, and applies hits with `applyLookedUpLocation`.
   - **Which jobs:** only fit-qualified jobs that have **no** `officialPosting` and whose location can't be used for salary.
   - **Transport:** it reuses the `job-compensation-research-batch` task id. The worker runs it two ways at once (built-in search and Tavily) and merges the answers with `mergeJobLocationLookupReplies` (`claudeTaskWorker.js:364`).
   - **Trust:** checks run on the host: the source must be an employer or ATS host, title and company must agree with the card, and the quote must contain the place.
   - **Cache:** in memory only, 30 days for a found place and 1 day for a miss.
   - **Measured 2026-11-09:** 7 of 24 correct with none wrong when both search tools ran together.

The salary step already prefers the finder's answer. `jobs.js` around lines 10213–10248 uses `officialPosting.location` and `officialPosting.salary` whenever the row has an official posting, through the same `applyLookedUpLocation`. **So the lookup is a second, narrower attempt at a search the finder already made, or never made, for that row.**

## Target

- `jobLocationLookup.js` no longer asks for a posting.
- The compensation pre-pass gets its location from the finder: a stored record if there is one, otherwise a finder run on the few jobs that need it. It then goes through the existing `officialPosting` branch, which already does the right thing.
- One prompt, one validator, one store and one set of host trust checks for every posting search.

## Steps

1. **Measure first (no code).** Rerun the 24 rows from the 2026-11-09 location A/B through `resolveOfficialPostings`, using the harness in `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-ziprecruiter-official-lookup/run.mjs`. Count how many get a usable, correct location (the lookup got 7, with 0 wrong), the cost per job, and the time. Record it with `scripts/ai-test-journal.mjs record`. Go on only if the finder finds at least as many correct places with none wrong.
   - **Done 2026-11-10** (`~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-finder-location-24/`, journaled): finder **9/24 correct, 0 truly wrong** (the matcher scored PlayStation "wrong" only for word order), 15 not found, $17.17 ($0.72/job), 792 s for all 24. The lookup got 7/24 for about $11. The gate passes on count, but the two are complementary: the finder found 5 the lookup missed (Zafin, Fellow, StreamingFast, AssemblyAI, Dropbox) and missed 3 it found (CARFAX, Doppel, Affirm); together 12. A straight replacement loses those 3. **Correction (2026-11-10, later):** this harness called the AI directly with the research task's own tools, so the finder searched with the built-in search ONLY. In the app the finder's research already runs three ways (built-in, Claude with Tavily, plain Tavily; `researchThreeWays` in `claudeTaskWorker.js`). So 9/24 understated the app's finder. **Rerun three-way the same day** (`.../2026-11-10-finder-location-24-threeway/`, journaled): **15/24 correct, 0 truly wrong**, 9 not found, $19.41 ($0.81/job, research $5.72 of it), 614 s, 0 failed calls. That is more than double the lookup's 7. It still misses 2 the lookup found (Doppel, Affirm); union 17. Gate passes clearly; replacing the lookup costs those 2 and gains 10. Before step 3, decide: (a) replace anyway, or (b) give the finder's research step the lookup's two-tool (built-in + Tavily) search, which is where the lookup's extra hits likely came from, then replace. Caveats: the truth came from earlier finder runs, so the sample favours the finder, and some "correct" answers such as Zafin's "Toronto and Ottawa" may still not be usable for salary.
2. **Make the finder callable from the compensation step.** Inject `resolveOfficialPostings` (default the real one) into `researchCompensationAssessments`, beside the existing `getPostingView` and `getConsolidatedLocation` injections. That keeps it testable without a network.
3. **Replace the pre-pass.**
   - Keep the selection: the fit gate, `classifyCompensationLocationGap === 'fixable'`, no `officialPosting`, and the 12-job cap with its strongest-fit-first order. Keep `selectLookupRequests` or move it into `jobs.js`.
   - Call the finder on the selected jobs, using the store's cached results, so a job searched earlier in the run isn't searched again.
   - A job whose result is `found` (or `link-only` with a location) gets its `officialPosting` attached exactly as Board refresh attaches it. It then falls into the existing branch at about line 10213, so no new location-applying code is needed.
   - Keep the `locationLookup` counters (`postings`, `resolved`, `notFound`, `rejected`, `failed`, `interrupted`, `overflowPostings`), filled from the finder outcomes. That way the bug-report section that prints them keeps working (one renderer in `electron/ipc/bugReport/`).
4. **Decide what a miss means.** Today a lookup miss is cached for 1 day in memory, while the finder's store remembers "not found". Use the store's own retry rule and don't add a second cache. A job the finder already marked not-found is not searched again in the same run.
5. **Delete the duplicate.**
   - Remove the prompt builder, the parsers, `evaluateLookupRow`, `runJobLocationLookup`, the cache, and the worker merge hook `jobLocationLookupPromptRequests`/`mergeJobLocationLookupReplies` in `claudeTaskWorker.js`.
   - Keep `applyLookedUpLocation` and `locationSourceLink` (the official-posting branch uses them), plus `companiesAgree`, `titlesPlausiblyAgree` and the host re-exports. Check each for other callers with `grep -rn` and move any keeper into a small `jobLocationApply.js` if `jobLocationLookup.js` goes away.
   - Remove the `job-compensation-research-batch` reuse note.
6. **Tests.**
   - Port what `scripts/tests/job-location-lookup.js` proves about the *selection* (fit gate, fixable-gap gate, 12 cap, deterministic order) to the new pre-pass, with an injected finder.
   - Drop the prompt and parser tests along with the code.
   - Add one test that a found official location reaches the salary assessment, and one that a finder failure leaves the card with its "location unavailable" fallback and the right counter.
   - Run the full `npm run test:unit` once at the end. Source-text assertions that name the deleted functions will fail and must be updated deliberately, not weakened (see memory: source-text assertions block file splits).
7. **Live check.** One Board Combine on a real board with a few location-less, fit-qualified rows. Confirm the bug report's location counters and that the cards show the official location with the "View official job posting" link.

## Cost and risk to weigh before step 3

- **Cost per job goes up.** The lookup is one batched research call for up to 12 jobs (two search tools). The finder measured about $0.53 per job on 2026-11-10, 84% of it judge calls, but it returns much more: salary, full description and apply link, all stored and reused by refresh and generation. With the 12-job cap the worst case is about $6 per Combine.
  - **Cheaper:** reuse an existing store result first.
  - **Cheaper still:** run only the research step and one judge for this location-only purpose. Only if step 1 shows the second judge adds nothing here, and only as a finder option, not a second finder.
- **Search tools.** The lookup's two-tools-together setup was its measured advantage (7/24 against 5 and 6 alone). Confirm that the finder's research step has the same Tavily fallback; it does for blocked page reads, per the 2026-11-09 notes. If it doesn't, port the two-way search into the finder, not into a new caller.
- **Durable handoff identity.** The lookup's prompt text is part of its resumable handoff identity. A run interrupted mid-lookup, before the upgrade, has a pending handoff the new build no longer recognises. Treat that as failed (counter `interrupted`), not as a crash.
- **No automatic fallback is added here.** This change only replaces who answers the location question; it doesn't change scraping.
