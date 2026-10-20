# Application improvement sessions

## Purpose and triggers

Improve application generation from real edits in batches, never from a single generation. More rules can lower quality; avoid rule creep.

Start a session when the private counter reaches 50, a bundle shows the due notice, the user asks to improve or review application generation, or the user announces a new ChatGPT model. The status also carries an early signal, `earlyDue` with `recurring`: one section of one document edited in four of the last eight accepted bundles since the last session, which is the shape a systematic defect takes. A bundle shows it as a suggestion; it is a reason to open a session early, not a rule by itself. At the start of *any* work on the application generator, check `application-improvement/state.json` in Electron's `userData` directory and mention if the counter is at least 50. The app keeps logging regardless of whether a session happens.

The private store contains `state.json` (up to 100 full pairs and about six months of compact edit summaries), `archive/` (pairs from earlier model labels), and a separate `frozen-regression.json` (about 20 pairs selected by improvement sessions only). Each pair records the posting, generated and latest saved résumé and letter, timestamps, build (commit, dirty flag, build time), and model label. Each summary row records one changed block without its text: document, section, block kind, and operation (`added`, `removed`, `rewritten` with word counts, `moved`, `markup`, `regenerated`, or `not needed`). Summaries describe the edit; the session still assigns its category. A removed letter is erased from both versions and marked `not needed`. The saved version is treated as sent, except in a pair with `supersededAt`: a regeneration in the same folder replaced it. Its `supersededReason` (also on the `regenerated` summary row as `reason`) says what that means: `same-build` is a rejected generation, `rebuild` is a re-run of the posting under new app code and says nothing about the earlier text, and `unknown-build` predates build stamps. Only `same-build` pairs count as rejections. Keep all of these files out of Git.

`config/application-model.json` is the small tracked model label. Development sessions maintain it; the app has no control for it. On macOS, Electron's `userData` path is usually under `~/Library/Application Support/`; confirm the actual app path before running `node scripts/application-improvement-state.mjs status --data-root <absolute-userData-path>`.

## New model

Update the label in `config/application-model.json` and rebuild the packaged app so it carries the new label. Let the app archive the previous full pairs and reset the counter on its next read or write. Verify the archived file and zero counter. Keep summaries and the frozen regression set. Make no code changes for the model transition itself.

## Improvement session

1. Load the pairs generated since the last session from the private store. The count can exceed the 100 full-pair retention limit; record the coverage actually available.
2. Classify every edit as truth error, evidence choice, wording, structure, length, letter structure, or user judgment call. Exclude removed letters from letter analysis.
3. Keep only patterns that recur across several bundles. A one-off edit is evidence to inspect, not a new rule.
4. Propose at most about three changes. Prefer removing or replacing guidance over adding it, and keep the writer brief within a fixed size budget.
5. Test each candidate offline. Replay on the logged jobs and measure closeness to the latest saved versions. Also run a blind play-the-hand panel, truth recall, and the frozen regression set. Compare panel results only within this session using the same renderer. Ship only proven wins.
6. Append a dated Session log entry below with what changed, why, and before and after numbers.
7. Refresh the frozen set to about 20 representative pairs. Only the session changes this file. Reset the counter with `node scripts/application-improvement-state.mjs reset --data-root <absolute-userData-path>` after the entry and regression set are saved.

## Hard rules

- Truth checks are never weakened. A user-reported false claim is fixed immediately, outside this batch process.
- No candidate or posting facts enter tracked files, including tests and session notes.
- The oracle gate stays at zero ngram findings.
- Live ChatGPT workers use the latest model at Extra High, never Pro.
- Panel comparisons are valid only within one session with the same renderer.

## Session log

### 2026-10-19

Run early at the user's request with the counter at 20 of 50. Coverage: 20 full pairs and 27 summary rows, all under the same model label; nothing exceeded retention. Five pairs were superseded, and every one of them was regenerated right after an app rebuild, so they were read as rebuild re-runs and left out of the edit analysis. Of the 15 accepted bundles, 7 carried edits: 6 résumés and 1 letter. Four letters were marked not needed. No truth errors.

Classification of the 18 block edits: evidence choice 11 (the Skills row trimmed in 5 bundles, a project line trimmed in 2, a project removed in 2 before the one-project cap existed, infrastructure detail trimmed in 2), structure and punctuation 5, wording 2. The Skills-row pattern traces to the host filling the block from the declared career skill inventory, so the fix is in the user's career data, not in code; it is re-checked next session before any code change is considered.

Changes shipped:

1. House punctuation style, stated by the user: candidate copy carries no em dash, no semicolon and no colon used as sentence punctuation, in either document; a hyphen joining words is fine, and en dashes inside date or numeric ranges stay allowed. The one live writer brief (`WRITE_VERIFY_BRIEF`) now states the rule in one sentence and is held to a fixed size budget. The candidate-copy gate (`assertCandidateDashPunctuation`) rejects semicolons and prose colons on both documents, its em-dash message no longer recommends either mark, and the letter's advisory punctuation check mirrors the gate. Offline replay on the 20 logged pairs with the new gate: 20 of 20 generated bundles and 14 of 15 saved bundles would be returned for correction (59 semicolons across the résumés and 9 across the letters, 13 prose colons across the letters and 3 across the résumés), against 0 of 20 under the old dash-only gate. The brief is what is expected to make writers comply before the gate; the next batch measures the correction rounds the gate costs through the `candidate-dash-punctuation` rejection id.
2. The edit log records why a pair was superseded (`same-build`, `rebuild`, `unknown-build`) so a rebuild re-run is never read as a rejection again.

Not run: the blind play-the-hand panel and truth recall, because the writer is a live ChatGPT worker with no offline replay path; the before and after numbers above are the deterministic replay only. Frozen regression set: the 15 accepted pairs of this batch. Counter reset after this entry.
