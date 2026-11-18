# Whole-repo cleanup, 2026-11-18

Two passes over all first-party code (about 312,000 lines in 28 areas). The `Job Application Design System` folder, `node_modules` and build output were not touched.

## What was done

- **Pass 1, per area.** 649 findings were audited, 74 of them bugs. Only findings a second reader confirmed were applied. 323 files changed.
- **Pass 2, across areas.** 62 findings that span more than one area: helpers written several times, code only tests could reach, and bugs and duplicated UI code that cross areas.

Shared helpers that now exist once:

| Helper | File |
| --- | --- |
| Escape text for a regular expression | `src/utils/regexEscape.js` |
| JSON with a fixed key order | `src/utils/stableJson.js` |
| Interview run id pattern | `src/utils/interviewRunIdGrammar.js` |
| SHA-256 as hex | `electron/utils/sha256Hex.js` |
| Sync a folder to disk, private store folder names | `electron/utils/pathSafety.js` |
| Lock per key | `createKeyedLock` in `electron/ipc/asyncMutex.js` |
| Bug report digest | `reportDigestHex` in `electron/ipc/bugReport/helpers.js` |
| "Output must be outside the repo" checks | `scripts/lib/outside-repo.mjs` |
| Poll until true, run an inline Electron entry | `scripts/lib/electron-smoke.mjs` |
| Modal focus trap | `src/components/useModalFocusTrap.js` |
| Marketplace recovery peek | `src/hooks/useMarketplaceRecoveryPeek.js` |

## Third pass, same day

The items first left on purpose were then done at the owner's request.

- **Cue-card controller.** The methods the window could no longer call are gone. Tests now drive answer matching the way the app does, through the listening path.
- **Cover-letter checks set to `off`.** All 29 deleted. Readers of stored data tolerate the retired ids.
- **Peer-boilerplate estimator.** Removed. Scores are unchanged, because it never ran with data.
- **Atomic file writes.** Nine copies now use `atomicWriteFile` in `electron/utils/atomicWrite.js`, with options that keep each caller's temp name, mode and sync behaviour.
- **Large files split.** `electron/ipc/jobs.js` (19,317 lines) is now an entry file plus 12 modules in `electron/ipc/jobs/`. `electron/ipc/browser/manualScraper.js` (9,418 lines) is an entry file plus 12 modules in `electron/ipc/browser/manualScraper/`. Shared state lives in `jobs/state.js` and `manualScraper/scrapeState.js`. Source-text tests read the split files through `scripts/tests/jobsSourceFixture.mjs` and `manualScraperSourceFixture.mjs`.
- **Design System folder.** Reviewed; little to remove. One duplicate upload image deleted and `ENGINEERING.md` corrected. `STYLE.md` and `CONTENT_RULES.md` now say section headings are untracked, which is what `resume.css` has always rendered; the AI reads both files when generating.

## Still left

- **Glassdoor and Google page helpers.** Reachable only from tests, but they are the only fixture coverage of that page logic.
- **Renderer imports from `electron/ipc`.** About 20 files share pure modules this way.
- **Test fixture `mountComponent.js`.** It bundles react-dom before the page globals exist, so `onChange` may not fire in tests that use it directly.

## Behaviour changes worth knowing

- Bug reports no longer show a cookie count on anti-bot verify checks. The check that produced it opened a hidden browser page only for that line.
- The location lookup after a challenge no longer delays the wait for the user to solve it.
- Script tests went from 226 to 216: the removed ten covered a measurement probe for an ElevenLabs model the app no longer uses.
