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

## B1 — pre-auth transport surface (2026-09-27)

Implemented and merged directly on local `main` in commit `ea046c1` (`feat: add ChatGPT bridge transport surface`). The stage adds the sole wire/body-parser and response helpers, the pinned v2s MCP tools, the stateless MCP JSON-RPC handler, the hardened HTTP request pipeline, and the Unix-socket listener. All tests use injected exchanges, clocks, HTTP, filesystem and network ports; none binds a socket.

Adversarial review covered body-read ordering, Host/Origin/fetch-metadata policy, anonymous versus authenticated permit pools, timer/permit release after injected faults, listener ownership and stale-socket handling, exact tool-call argument copying, fixed error bodies, and the pre-auth import boundary.

| Gate | Result |
|---|---|
| G0 | Green. The stage diff contains only the six B1 modules and its two owned registered test files; no ignored path or out-of-allow-list edit. |
| G1 | Green, 0 failed. The required non-bridge per-file baseline diff was empty; focused HTTP (81), MCP (35), and source-scan (4) checks also passed immediately before commit. |
| G2 | Green. `npm test` passed. |
| G3 | Green. `npm run lint` passed; the final targeted ESLint run was also clean. |
| G4 | Green. `npm run build:compile` passed. |
| G8 | The B8 conformance runner does not exist yet; the complete in-process wire table passed as the plan's stated equivalent. |
| G9 | Green. Frozen files and `package-lock.json` were untouched. |
| G10 | Green after adversarial transport/listener review; no untrusted free text reaches a log or error response. |

## B2 — OAuth authorization server (2026-09-27)

Implemented and merged directly on local `main` in commit `031408f` (`feat: add hardened ChatGPT bridge OAuth server`). The reviewed lab server is split across the import-restricted core, page renderer, guarded metadata/JWKS fetcher, synchronous hash-only store and RS256 client-assertion verifier. Production has no DCR or static-secret client, uses one armed pairing window and one active grant, and enforces the 3-day idle / 14-day absolute refresh lifetimes.

The registered suite preserves the original lab step names and order while explicitly marking the Phase 1 changes, then adds the hardening and `private_key_jwt` battery. Adversarial review covered assertion-before-token-lookup ordering, algorithm confusion, DNS/redirect/body guards, refresh reuse, persistence failure, pairing exhaustion, fixed errors and sentinel leakage.

| Gate | Result |
|---|---|
| G0 | Green. The diff is exactly the five B2 modules and `handoff-bridge-oauth.js`; no ignored or out-of-allow-list path. |
| G1 | Green, 0 failed. The OAuth group and required baseline comparison passed. |
| G2 | Green. `npm test` passed. |
| G3 | Green. `npm run lint` and the final targeted ESLint run passed. |
| G4 | Green. `npm run build:compile` passed. |
| G7 | Green under CI's Node 22 through the `act` command recorded above. |
| G9 | Green. Frozen files and `package-lock.json` were untouched. |
| G10 | Green after review of `oauth.js`, `oauthPages.js`, `cimd.js`, `oauthStore.js` and `clientAuth.js`; no credential or remote error text crosses the boundary. |

The unchanged lab rows passed the local oracle comparison; rows intentionally changed by the Phase 1 decisions were excluded exactly as specified.

## B3 — app-supervised cloudflared tunnel (2026-09-27)

Implemented and merged directly on local `main` in commit `2e553f9` (`feat: supervise the ChatGPT bridge tunnel`). The stage adds the validated Unix-socket ingress config, copy-then-inspect binary trust, bounded credential parsing, constant watchdog launcher, process-table orphan reaper, loopback/public probe seam, redacted log ring and serialized supervisor state machine.

Adversarial review covered every tunnel invariant I-1 through I-12, including the app-owned pinned binary copy, required flags, positional-argument shell wrapper, process-group ownership, PID-reuse checks, TERM/TERM/KILL escalation, metrics-port range, unrequested-exit loop, secret redaction and test-mode trust narrowing.

| Gate | Result |
|---|---|
| G0 | Green. The diff is exactly `tunnel/`, its registered test, and the out-of-band self-test; no ignored or out-of-allow-list path. |
| G1 | Green, 0 failed. The injected tunnel group passed 85 cases and the required baseline comparison was empty. |
| G2 | Green. `npm test` passed without spawning a real child. |
| G3 | Green. `npm run lint` and the final targeted ESLint run passed. |
| G4 | Green. `npm run build:compile` passed. |
| G8 | The B8 conformance runner does not exist yet; the full injected tunnel group is the stated equivalent. |
| G9 | Green. Frozen files and `package-lock.json` were untouched. |
| G10 | Green after review of every `tunnel/*` module and the literal watchdog script. |

`npm run test:tunnel` passed outside the filesystem/process sandbox as required: five temporary fake children, exit status preserved, TERM during sleep completed in 213 ms, and the helper-crash/reaper path removed the TERM-ignoring connector and grandchild in 4037 ms across the 0/333/666 ms poll offsets; the different-config look-alike survived. The first sandboxed invocation could not call `/bin/ps` and was correctly treated as a harness restriction, not a product result.

## B4 — application data plane (2026-09-27)

Implemented and merged directly on local `main` in commit `f4b532b` (`feat: add ChatGPT bridge application engine`). The stage adds application lanes and framing, the memory-only chat epoch, depth-first scheduler, single-flight get/submit paths, application adapter, durable release metadata, split security/serve ledgers, and the sole validated config writer.

The clean-clone adversarial pass caught and closed four issues before merge: the B0 framing import allowance, lifecycle audit events being dropped, an internal recovery submit that could retain a semaphore forever, and different replacement bytes overtaking retained crash-gap bytes. The audit schema now also rejects a field named `code`, even when its value looks safe.

| Gate | Result |
|---|---|
| G0 | Green. Against the separately committed B0 source-scan correction, the stage diff is exactly eight allowed production files and three allowed registered tests; no ignored path. |
| G1 | Green in an isolated clean clone: 1628 passed, 0 failed; the required non-bridge baseline diff was empty. The final focused engine suite passed 60 cases. |
| G2 | Green. `npm test` passed in the isolated clone. |
| G3 | Green. `npm run lint` passed. |
| G4 | Green. `npm run build:compile` passed. |
| G8 | The B8 conformance runner does not exist yet; the engine plus real application integration groups passed as the stated equivalent. |
| G9 | Green. SHA-1s of all seven frozen files were identical. |
| G10 | Green after persistence, scheduling, error-text, audit and semaphore/watchdog review. No prompt, answer, job id, handoff code, path or label reaches a ledger or logger. |

The temporary clean clone was removed. Nothing was pushed.

## B5b — scoring push adapter and engine integration (2026-09-27)

Implemented directly on local `main` in commit `0d2bb58` (`feat: add ChatGPT bridge scoring push adapter`). The stage adds the default-deny task policy, process-scoped hub selection, per-epoch push routing and tombstones, bounded verdict caching, successor-grace polling, and the application-continuation / push / fresh-application scheduler order.

Adversarial review closed stale Save-As selections, two-sender node collisions, held-reason loss, post-hold push polling, prompt-budget replay, accepted-verdict double framing, and incomplete injected-fault coverage. A settled accepted replay now increments counters and polls for its successor exactly once; every relevant adapter await can fail without poisoning the following operation.

| Gate | Result |
|---|---|
| G0 | Green. The stage commit contains exactly `electron/ipc/handoffBridge/sources/push.js`, `electron/ipc/handoffBridge/engine.js`, and `scripts/tests/handoff-bridge-push.js`; the new path is not ignored and `git diff --check` is clean. |
| G1 | Green in an isolated clone: `npm run test:unit` passed 2014 tests with 0 failed. The required filtered comparison with `~/ic-baseline-units.txt` printed nothing. Focused push (42), engine (60), and source-scan (4) groups passed immediately before commit. |
| G2 | Green. `npm test` passed the complete unit and resume-PDF suites. |
| G3 | Green. `npm run lint` and targeted ESLint passed. |
| G4 | Green. `npm run build:compile` passed with only the existing chunk-size warnings. |
| G8 | The B8 conformance runner does not exist yet; the complete in-process push and engine groups passed as the plan's stated equivalent. |
| G9 | Green. All frozen files and `package-lock.json` are byte-untouched. Only `sources/push.js` imports the four `nonApiAi.js` seam names and `snapshotActiveNodeTasks`. |

The isolated gate clone was removed after the clean run. Nothing was pushed.

## B6 — controller, exposure controls and Electron integration (2026-09-27)

Implemented directly on local `main` in commit `c4475cf` (`feat: integrate ChatGPT bridge controls`). The stage composes the controller, Unix-socket listener and supervised tunnel; pairing and guarded probes; fixed-schema IPC and native dialogs; Tray, Dock, notification and power policy; durable partial tunnel setup; main/preload lifecycle hooks; status/log/activity projection; and the complete B6 controls, IPC, privacy, source-scan and inert test ownership.

Adversarial review closed pairing sheets that were acknowledged without appearing, stale explicit and automatic release ownership after renderer/window changes, partial-setup rollback and restart semantics, public-reachability normalization, fixed-argument orphan cleanup, Tray state/nudge gaps, Disable/quit lifecycle races, and a canvas disappearing during the enable consent flow. The first Node 22 gate then exposed a synthetic-UID portability bug and a TEST MODE version-probe precedence bug; commit `272031a` (`fix: harden bridge platform test mode`) corrected both and moved the macOS system-alias regression into the bridge-owned test group. The underlying narrow `/var`, `/tmp` and `/etc` canonical-alias fix is commit `de5d6ae`.

| Gate | Result |
|---|---|
| G0 | Green. Commit `c4475cf` contains exactly the eleven allowed B6 production paths and five B6-owned registered tests; no ignored path. Separately reviewed corrective changes are isolated in `de5d6ae` and `272031a`. |
| G1 | Green: 2209 tests passed with 0 failed under Node 22 at the gate SHA; the required filtered comparison with `~/ic-baseline-units.txt` printed nothing locally. Focused controls, IPC, inert, privacy and source-scan groups also passed. |
| G2 | Green. `npm test` passed locally and under Node 22. |
| G3 | Green. `npm run lint` and targeted ESLint passed locally and under Node 22. |
| G4 | Green. `npm run build:compile` passed locally and under Node 22 with only the existing chunk-size warnings. |
| G5/G6 | Deferred exactly to B7.5, which owns the inert and enabled-path Electron smokes and lands next. |
| G7 | Green at `272031a837a0b13f8d18913258e42047222d8793` through the recorded `act` command on Node 22.23.2. The first run's synthetic UID failure was fixed and the rerun completed lint, 2209 unit tests, résumé-PDF tests and compile. |
| G8 | The complete in-process B6 equivalents passed. The B8.1 shortened all-suite also passed during its independent audit; the mandatory full suite and ten-minute soak remain B8's gate. |
| G9 | Green. All user-frozen files and `package-lock.json` are byte-untouched. |
| G10 | Green after two independent reviews of the controller, pairing/probes, IPC/dialogs, Tray/power, composition and Electron lifecycle hunks. No open B6 security finding remains. |

The temporary clean clone used by `act` was removed. Nothing was pushed.

## B7 — renderer controls and Electron smokes (2026-09-27)

Implemented directly on local `main` in commit `7b3f24e` (`feat: add ChatGPT bridge renderer controls`) and completed by `33e199a` (`test: add ChatGPT bridge Electron smokes`). The renderer work adds the status/store boundary, health model, sidebar trigger, popover, Settings controls, setup flow, crash-isolated mounting, publisher and render harness. The inert and enabled-path Electron smokes cover SM1–SM8, the exact preload surface, disabled-mode inactivity, TEST MODE setup, pairing, application drain, controlled shutdown, watchdog escalation and orphan reaping.

Adversarial review closed an enable attempt that could proceed despite an unavailable platform (`be63b1a`) and a composition omission that prevented the publisher's coalesced job hint from reaching the engine (`6a9565b`, alongside B8.4's report-redaction work). The native pairing sheet owns formatting while the test hook retains the raw compact code, and the orphan test allows the documented delayed-reaper plus TERM/TERM/KILL bound without weakening the six-second watchdog assertion.

| Gate | Result |
|---|---|
| G0 | Green. The renderer commit contains exactly the B7.1–B7.4 production and owned test paths; the smoke commit contains exactly `scripts/electron-smoke.js` and `scripts/electron-bridge-smoke.js`. The two corrective changes are isolated in the commits named above. No new ignored path or whitespace error. |
| G1 | Green. `npm run test:unit` passed with 0 failed and the exact filtered comparison with `~/ic-baseline-units.txt` printed nothing. Focused UI (8) and render (12) groups passed. |
| G2 | Green. `npm test` passed. |
| G3 | Green. `npm run lint` and targeted ESLint passed, including the React Compiler rules. |
| G4 | Green. `npm run build:compile` passed with only the existing chunk-size warnings. |
| G5 | Green. `npm run test:e2e` ended with `Electron smoke test passed`; the bridge stayed off, created no bridge directory or socket, spawned no cloudflared descendant and reported no renderer error. |
| G6 | Green twice. `npm run test:e2e:bridge` completed the enabled TEST MODE flow, including pairing, real Unix-socket/SDK handoff drain, Disable cleanup, watchdog escalation and launch-entry orphan reaping. |
| G9 | Green. All frozen files, `package-lock.json` and the B0-only `package.json` remained byte-untouched. |

Nothing was pushed.

## B8 — hardening, conformance and operating runbook (2026-09-27)

Completed on local `main` through code/gate commit `8e8a8bd` (`fix: retain Electron smoke lifecycle pin`). The stage adds the real SDK 1.30.1 conformance package and all eight suites, completes the privacy/source sweeps and hostile-answer import tests, extends the operating runbook and design documents, wires hostname redaction into generated reports, and closes the final cross-stage security findings. The main B8 commits are `c25ff2c` (runbook), `ecbe2f8` (hostile-answer coverage), `47061a5` (timing-safe credential lookup), `c8171f5` (security-race remediation), `07c9b9b` (privacy/source scans), `0d9f6cc` (conformance harness), `2846d47` (production-paced soak), `69d480e` (smoke teardown verification), and `8e8a8bd` (the frozen smoke lifecycle pin). Commit `6a9565b` contains B8.4's hostname-redaction work alongside the B7 publisher correction.

The security pass closed duplicate-authorization preflight bypasses, OAuth-directory durability, timing-safe handoff lookup, delayed-call epoch/source races, concurrent epoch reservation, restart-confirmation duplication, successor byte-budget bypass, and terminal-snapshot pruning. The conformance and test-quality pass added raw HTTP byte goldens, complete DNS egress guards, authenticated traffic during the 10,000-input abuse flood, a live ten-minute soak paced below the production bucket, and OS-verified Electron teardown that cannot signal an unrelated process or process group. Multiple independent final reviews found no open code-level security or cleanup issue.

The wire goldens under `scripts/tests/fixtures/handoff-bridge/` are the deferred B0.6 capture output required by B8.1 and were written only through the closed capture allow-list. The production fixes outside the ordinary B8 artifact paths are isolated in `c8171f5` as the B8.5 security-remediation commit. Commits `69d480e` and `8e8a8bd` make the final B8.5 teardown correction and required source pin in B7.5-owned `scripts/electron-smoke.js` and `scripts/electron-bridge-smoke.js`. These reviewed cases are intentional gate-remediation extensions of the task file lists, not stray stage edits.

| Gate | Result |
|---|---|
| G0 | Green. The merged paths match the task allow-lists plus the documented capture and gate-remediation extensions above; `git check-ignore -v` produced no result for any added path; the scoped ignored-file check was empty; no committed tunnel credential, whitespace error, or unstaged path remains. |
| G1 | Green at `8e8a8bd`. `npm run test:unit`: 2241 passed, 0 failed, 66 groups, 23.3 s. The exact required filtered comparison with `~/ic-baseline-units.txt` printed nothing. |
| G2 | Green. `npm test` passed all 2241 unit tests and every resume-PDF suite. |
| G3 | Green. `npm run lint` passed after the final smoke lifecycle correction. |
| G4 | Green. `npm run build:compile` passed with only the existing Vite chunk-size warnings. |
| G5/G6 | Green at `8e8a8bd`. `npm run test:e2e` printed `Electron smoke test passed`; `npm run test:e2e:bridge` printed `Electron bridge smoke test passed`. A fresh host process-table audit found no Electron test, fake-cloudflared, conformance, or temporary-userData process afterward. |
| G7 | Green at `8e8a8bde90f636f65c707d25d4e5b7389ba9b7b4` under CI's Node 22.23.2/npm 10.9.8. The recorded `act` command completed lint, all 2241 unit tests, resume-PDF tests and compile in about 47 s; only the CI workflow ran. |
| G8 | Green. `npm run test:tunnel` passed all five fake-child/watchdog/reaper cases. The mandatory real-socket/SDK `--suite=all` run passed wire (89 ms), OAuth (11 ms), drain (106 ms), push (under 1 ms), abuse (1830 ms), soak (600002 ms), tunnel (4700 ms), and orphan (5697 ms), including the 10,000-input flood, stall/heap/handle budgets and ten-minute soak. The full conformance run was made at `2846d47`; later commits changed only Electron-smoke teardown and its required source literal, leaving conformance and product bridge code unchanged. |
| G9 | Green. Every frozen file and root `package-lock.json` is byte-untouched from `b7d1592`; `package.json` differs by exactly the three B0 scripts. `electron/ipc/nonApiAi.js` remains `4c475c198a173dd81531b33f65edf22a05d9d48c258044a5d6722c1ac1b7c4f6`. |
| G10 | Green. Independent reviews of the B1, B2, B3, B6 and B8 security boundaries, hostile-answer path, conformance quality and teardown logic have no open finding. |

The two temporary CI clones, parked nested dependencies and every test child were removed after the final runs. The checkout has one worktree and one branch, `main`. Nothing was pushed.

B0 through B8 are complete. Work stops here by design: B9 through B11 require Jack's packaged-app observations, real Cloudflare route and DNS controls, ChatGPT staging/production plugins, pairing code and synthetic-only manual runs. No real career data crossed the bridge.

## B9 — packaged-app verification (in progress, 2026-09-27)

The packaged UI report exposed unstyled bridge controls and narrow-window overflow in Settings. The local-main remediation is commit `e511ef5` (`fix: refine ChatGPT bridge setup UI`). It adds shared responsive button and icon-control styles; keeps the Settings, popover, setup dialog and nested confirms within a narrow viewport; closes Settings before opening the popover; preserves in-progress setup fields across status updates; tightens action and setup-step prerequisites; restores focus correctly; and shortens the dense operational copy without removing safety instructions.

| Check | Result |
|---|---|
| Scope / frozen files | Green. Exactly the ten listed UI, CSS, copy and regression-test files changed; the user-frozen files and package files remain untouched. |
| Unit / baseline | Green. `npm test` passed 2242 unit tests plus all résumé-PDF checks; the required filtered baseline comparison printed nothing. |
| Lint / compile | Green. `npm run lint` passed; production compilation passed with only the existing Vite chunk-size warnings. |
| Electron UI | Green. `npm run test:e2e` exercised the 320px Settings, popover and setup-dialog layouts and passed. `npm run test:e2e:bridge` passed through the synthetic enabled bridge flow. |
| Adversarial review | Green after closing the last finding: First chat can no longer be reached while a previously linked tunnel is unreachable. |

The real-network, pairing, Cloudflare/DNS and production-plugin observations remain Jack-only B9–B11 work. No bridge was enabled in the user app and no real career data crossed it during this remediation.

### B9 checkbox status remediation (2026-09-27)

The packaged bug report showed that bridge preferences were durably saved while their controlled Settings checkboxes stayed stale. The fix is commit `d41dce3` (`fix: refresh ChatGPT bridge settings`). The off-state bootstrap and each live controller previously started their status sequence at zero, so an off-state save could publish another sequence-zero snapshot that the renderer correctly rejected as equal/stale. The IPC bridge now owns one monotonic public sequence across off-state saves, attach/detach and runtime replacement, while retaining the controller's source ordering and stable identity for unchanged reads.

The remediation also sends scope changes as independent partial patches, prevents a delayed old-controller callback or cross-userData re-registration from restoring prior state, and detects port-derived status changes such as tunnel reachability even when the controller source sequence has not advanced. The mounted regression exercises the master switch and all five Settings preferences, including rapid Applications/Scoring changes and a failed non-optimistic save. The optional D10 bug-report telemetry/lens remains unimplemented and off.

| Gate | Result |
|---|---|
| G0/G9 | Green. Exactly four reviewed bridge/UI/test files changed in the code commit; no added or ignored path, whitespace/invisible-character finding, frozen-file change, package change or D10 report change. |
| G1 | Green. `npm run test:unit` passed 2246 tests with 0 failed; the exact filtered comparison with `~/ic-baseline-units.txt` printed nothing. |
| G2 | Green. `npm test` passed all 2246 unit tests and every résumé-PDF suite. |
| G3/G4 | Green. `npm run lint` and `npm run build:compile` passed with only the existing Vite chunk-size warnings. |
| G5/G6 | Green. The final `npm run test:e2e` printed `Electron smoke test passed`; the final `npm run test:e2e:bridge` printed `Electron bridge smoke test passed`. The first enabled-smoke attempt exposed the same-source-sequence tunnel-reachability cache edge; it was fixed, regression-tested and rerun green before commit. |
| G7 | Green at `d41dce3aa81078f81070161abdf36a548027e4df` under Node 22.23.2/npm 10.9.8. The recorded `act` command completed lint, 2246 unit tests, résumé-PDF tests and compile; its temporary full clone was removed. |
| G10 | Green after independent sequence/lifecycle, privacy/spec, UI/accessibility, test-quality and final integrated reviews. No open finding remains. |

Nothing was pushed. The remaining B9–B11 real-network and ChatGPT steps still require Jack.
