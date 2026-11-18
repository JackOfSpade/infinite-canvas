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

## Left on purpose

These need an owner decision or are not worth the risk.

- **Cue-card controller methods with no channel.** `electron/interviewWindow.js` still has `submitQuestion`, `followUpQuestion`, `selectPreparedCard`, `nextQuestion`, `useTranscriptQuestion`, `setAlwaysOnTop`, `setLatencyMode`, `close` and `getListeningState`. The window can no longer call them, but many tests drive the live matching logic through them.
- **Cover-letter checks set to `off`.** They run only in tests. Stored check ids still name them, so none was deleted.
- **Peer-boilerplate estimator (Amendment 3).** Built and tested but not wired in. Wire it or drop it.
- **Atomic file writes.** Three copies differ in temp name, file mode, sync and cancel handling. Merging them could change what lands on disk.
- **Large files.** `electron/ipc/jobs.js` and `electron/ipc/browser/manualScraper.js` were not split, because tests assert their source text.
- **Glassdoor and Google page helpers in `manualScraper.js`.** Reachable only from tests, but they are the only fixture coverage of that page logic.
- **Renderer imports from `electron/ipc`.** About 20 files share pure modules this way; moving two of them would not change that.
- **Test fixture `mountComponent.js`.** It bundles react-dom before the page globals exist, so `onChange` may not fire in tests that use it directly. Fixing it touches about 10 test files.
- **Tone notes.** Nothing ever wrote them, so the review prompt section and the replay markers that read them were removed instead of inventing a writer.

## Behaviour changes worth knowing

- Bug reports no longer show a cookie count on anti-bot verify checks. The check that produced it opened a hidden browser page only for that line.
- The location lookup after a challenge no longer delays the wait for the user to solve it.
- Script tests went from 226 to 216: the removed ten covered a measurement probe for an ElevenLabs model the app no longer uses.
