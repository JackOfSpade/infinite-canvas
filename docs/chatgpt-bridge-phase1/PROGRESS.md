# ChatGPT bridge Phase 1: build progress

Running note for the Phase 1 build (plan: `build-plan.md`, design: `addendum.md`). One section per stage: what ran, gate results, the commit merged to local `main`. Newest last. Nothing here is pushed until Jack says so.

## How the build runs

- Orchestrator: the primary Codex session (gpt-5.6-sol). Grunt work and independent reviews: gpt-5.6-terra sub-agents, followed by orchestrator integration and gate runs.
- Per Jack's 2026-09-27 direction, stages are committed directly on local `main`; no temporary branch or worktree is created. Nothing is pushed (`.github/workflows/auto-merge-to-main.yml` would otherwise land a green branch tip).
- Gates: G0 allow-list and ignored-path checks, G1 `npm run test:unit` plus the per-file baseline diff against `~/ic-baseline-units.txt` (filter `grep -v -E 'handoff-bridge|non-api-ai-bridge-seam'`), G2 `npm test`, G3 `npm run lint`, G4 `npm run build:compile`, G5 `npm run test:e2e` (run in the main checkout), G9 frozen files untouched.

## Baselines (2026-09-26, main at b7d1592, before any bridge code)

| Check | Result | Wall time |
|---|---|---|
| `npm run test:unit` | 1486 passed, 0 failed, 49 groups | 17 s |
| `npm run test:resume-pdf` | 23 passed, 0 failed | 1 s |
| `npx eslint .` | clean | 8 s |
| `npm run build:compile` | green | 1 s (cached) |
| `npm run test:e2e` | `Electron smoke test passed` | 20 s |

Per-file baseline: `~/ic-baseline-units.txt`, 49 lines; non-api-ai 75/75, job-diagnostics 269/269, platform-utils 56/56, electron-regressions 40/40, application-handoff-dock 42/42. Node 26.4 locally (CI is Node 22). Nothing running (`pgrep -fl "node server.js|cloudflared"` empty).

G7 (act) at this commit: green in 40 s with the command below (CI workflow only, never `auto-merge-to-main.yml`).

## Handoff to ChatGPT Codex (2026-09-27)

Jack stopped the Claude build to hand it to Codex. **Stage B0 was started and stopped before anything was committed**: one unreviewed draft of `constants.js` was discarded, the worktree and branch `bridge/B0` were deleted, and `main` is the only branch again. `electron/ipc/handoffBridge/` does not exist. The next step is still B0 from the top. Local `main` is 1 commit ahead of `origin/main` (this file); nothing was pushed.

Checked before the stop (still true at this commit):
- The frozen files and the anchors the plan cites are unchanged since the planning commit 3773b2e (`nonApiAi.js`, `localAiApplication.js`, `App.jsx`, `SettingsPanel.jsx`, `Sidebar.jsx`, `main.js`, `preload.js`), and `push-seam-prototype/nonApiAi.seam.patch` still applies cleanly to `electron/ipc/nonApiAi.js` (`git apply --check`).
- Node 22 is not installed locally (Homebrew has node 23, 25, 26); the act run is the only Node 22 check.

Practical notes for whoever continues:
- **Worktrees:** do not put worktrees inside the repo (for example under `.claude/`): `npx eslint .` in the main checkout lints everything that is not in its `globalIgnores`, so a worktree inside the tree gets linted twice. A worktree outside the repo needs `ln -s "<repo>/node_modules" node_modules` (the `.gitignore` pattern `node_modules` without a slash also ignores the symlink) and, for the B0.6 golden generator, the same symlink for `scripts/chatgpt-handoff-spike/node_modules` (git-ignored, so absent in a fresh worktree).
- **G7 without pushing:** in a detached worktree at the SHA: `printf '{"ref":"refs/heads/main","after":"<sha>","before":"0000000000000000000000000000000000000000"}' > event.json && timeout --preserve-status 900 act push -W .github/workflows/ci.yml --eventpath event.json --container-architecture linux/arm64 --concurrent-jobs 1`. `-W` keeps act away from `auto-merge-to-main.yml`.
- **Invisible characters:** after writing any file that mentions `•`, `…`, `\u200B`, `\u2028` or similar, scan it for Unicode categories Zs (other than a plain space), Zl, Zp and Cf and re-escape any literal character; then lint.
- **Starter mask:** the UI analysis shows `STARTER_MASK` as `'•••••-•••••'` (the old 10-character code); round 2 made the chat key 26 symbols with no separator, so the mask must follow the 26-symbol key.
- **Parallel streams after B0** (disjoint files, at most four worktrees): B1 and B2 in one worktree (B2.1 imports B1.1's `wire.js` and `respond.js`); B3 alone; B4 and B5a together (B5b needs B4.2, B4.4 and B5a.2); B7.1 to B7.4 plus B7.2 can start right after B0 (they depend only on B0.5 and B0.4). Then B5b, B6, B7.5, B8.
- **Skeleton tests for B0.5** (one allocation that worked on paper; each file needs at least one real test): `-http` harness self-tests (fake exchange, fake clock, `faultAt`, `withLeakCheck`); `-tunnel` fake spawn and process table plus the launcher asserted as text; `-controls` constants pins; `-privacy` sentinels, fixture-folder scan, `git check-ignore`; `-mcp` golden, hash and starter/continue pins; `-oauth` client-metadata fixture and OAuth constants; `-ipc` the IPC contract (24 invoke channels, `publish-jobs`, 3 events, no `label`); `-engine` contracts, `errors.js`, `log.js`; `-store` tolerant `readConfig`; `-ui` `handoffBridgeConfig.js` validators and zero imports; `-render` mount-helper self-tests; `-application` `adaFlow` sanity and the four `localAiApplication.js` exports; `-push` and the seam file minimal source-text skeletons; `-hostile` hostile-fixture sanity; `-inert` from B0.3; `-source-scan` the whole table.

## B0 — inert skeleton and frozen contracts (2026-09-27)

Implemented directly on local `main` in commit `af43dcf` (`feat: add inert ChatGPT bridge skeleton`). The stage added the inert bridge module boundary, frozen constants/contracts, closed logging and audit schemas, read-only config store, shared validation/templates, all shared fixtures, the complete 48-row source scan, all 17 registered test files, the three package scripts with exit-2 stubs, and the provisional goldens. The v2s surface hash is `73c80b65180180ad3df73f3f6d79d7885ee1fc597d5e85e659206ee69e91d5a2`.

Adversarial review closed the following before the gate: arbitrary safe-looking log fields; test-mode symlink escapes; alternate Node loader and code-generation aliases in the source scan; partial telephone matches in fixture privacy checks; comment-separated imports in the zero-import check; and render-bundle timeout cleanup. Final spec, security and test-quality re-reviews found no B0 blocker.

| Gate | Result |
|---|---|
| G0 | Green. The diff matched the B0 allow-list; `git check-ignore -v` produced no result for any new path; no new ignored fixture, literal `TunnelSecret`, forbidden invisible character, or unstaged path; `git diff --check` was clean. |
| G1 | Green. `npm run test:unit`: 1523 passed, 0 failed, 66 groups, 16.98 s wall time (1486 baseline + 37 B0 skeleton tests). The required filtered diff against `~/ic-baseline-units.txt` was empty. |
| G2 | Green. `npm test` completed both the 1523-test unit run and the resume-PDF suite. |
| G3 | Green. `npm run lint`. |
| G4 | Green. `npm run build:compile`. |
| G5 | Green. `npm run test:e2e` on the main checkout ended with `Electron smoke test passed` (the sandboxed launch was retried with GUI permission). |
| G9 | Green. All frozen files and `package-lock.json` were byte-untouched; `package.json` changed by exactly the three B0 scripts. |

Each placeholder command (`test:e2e:bridge`, `test:tunnel`, `selftest:handoff-bridge`) was also invoked at its underlying script boundary and exited 2 with `not implemented yet`, as required until B7.5, B3.5 and B8.1 respectively.

## B5a — non-API AI push/scoring seam (2026-09-27)

Implemented the required split on local `main`: commit `c76c425` (`refactor: hoist non-API AI response acceptance`) is the verbatim handler hoist, and commit `137cf6d` (`feat: add non-API AI bridge seam`) adds the bridge-only seam and its full record-kind/response-scenario coverage. The final SHA-256 of `electron/ipc/nonApiAi.js` is the required prototype result, `4c475c198a173dd81531b33f65edf22a05d9d48c258044a5d6722c1ac1b7c4f6`.

Adversarial review covered IPC/bridge differential parity, exact return shapes, lifecycle isolation, durable-write failure recovery, all 25 known task ids, duplicate-fingerprint behavior, and the frozen log/runtime/abort-listener pins. No module state, IPC channel, safe code or lifecycle field was added by the seam.

| Gate | Result |
|---|---|
| G0 | Green. The stage diff is exactly `electron/ipc/nonApiAi.js` and `scripts/tests/non-api-ai-bridge-seam.js`; no ignored or out-of-allow-list path, `TunnelSecret`, whitespace error, or unstaged stage path. |
| G1 | Green. `npm run test:unit`: 1532 passed, 0 failed, 66 groups, 18.64 s. The exact required filtered diff against `~/ic-baseline-units.txt` was empty; the five pinned existing groups remained 75/269/56/40/42. |
| G2 | Green. `npm test`: 1532 unit tests and 420 resume-PDF tests passed, 0 failed, 18.99 s. |
| G3 | Green. `npm run lint`, 6.72 s. |
| G4 | Green. `npm run build:compile`, 0.72 s (only the existing Vite chunk-size warning). |
| G7 | Green under CI's Node 22.23.2. The exact `act` command from this file completed lint, test and build in 42 s from a temporary full local clone at `137cf6d`. A first detached-worktree attempt false-failed because `act` mounted the worktree's external `.git` gitfile without its target, making in-container `git check-ignore` exit 128; the full-clone rerun removes that harness artifact. |
| G9 | Green. Frozen files and `package-lock.json` are byte-untouched. The commit-1 moved-code review shows only the intended hoist/delegation, and the commit-2 file hash matches the unsplit prototype exactly. |

The temporary full clone, detached gate worktree, Docker job container and gate artifacts were removed after the clean run. Nothing was pushed.
