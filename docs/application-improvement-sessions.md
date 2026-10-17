# Application improvement sessions

## Purpose and triggers

Improve application generation from real edits in batches, never from a single generation. More rules can lower quality; avoid rule creep.

Start a session when the private counter reaches 50, a bundle shows the due notice, the user asks to improve or review application generation, or the user announces a new ChatGPT model. At the start of *any* work on the application generator, check `application-improvement/state.json` in Electron's `userData` directory and mention if the counter is at least 50. The app keeps logging regardless of whether a session happens.

The private store contains `state.json` (up to 100 full pairs and about six months of compact edit summaries), `archive/` (pairs from earlier model labels), and a separate `frozen-regression.json` (about 20 pairs selected by improvement sessions only). Each pair records the posting, generated and latest saved résumé and letter, timestamps, build (commit, dirty flag, build time), and model label. Each summary row records one changed block without its text: document, section, block kind, and operation (`added`, `removed`, `rewritten` with word counts, `moved`, `markup`, `regenerated`, or `not needed`). Summaries describe the edit; the session still assigns its category. A removed letter is erased from both versions and marked `not needed`. The saved version is treated as sent, except in a pair with `supersededAt`: a regeneration in the same folder replaced it, so treat it as a rejected generation, not an accepted one. Keep all of these files out of Git.

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

No improvement session has run under this playbook yet.
