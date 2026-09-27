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
