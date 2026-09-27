# ChatGPT bridge Phase 1: build progress

Running note for the Phase 1 build (plan: `build-plan.md`, design: `addendum.md`). One section per stage: what ran, gate results, the commit merged to local `main`. Newest last. Nothing here is pushed until Jack says so.

## How the build runs

- Orchestrator: the main Claude session (Opus). Grunt work: Sonnet sub-agents driven by the Workflow tool, one implementer per task, then adversarial reviewers (spec, correctness and security, test quality) and a fixer, then the orchestrator runs the gate commands itself.
- Each stage is built in a temporary git worktree under `/private/tmp/ic-wt/<stage>` on a local branch `bridge/<stage>` (node_modules symlinked from the main checkout). When the gate is green the stage tip merges into local `main` and the branch and worktree are deleted, so `main` stays the only branch. Stage branches are never pushed (`.github/workflows/auto-merge-to-main.yml` would land any green tip).
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
