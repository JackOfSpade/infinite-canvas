# AI test run log

Written by the test tools themselves while they run (`scripts/ai-test-journal.mjs`): `claude-effort-ladder.mjs`, `ai-task-replay.mjs`, `web-research-ab.mjs` and `live-bundle-harness.mjs`. Each section is one run. It appears when the run starts, is rewritten as results arrive, and is marked interrupted if the process is stopped, so the numbers survive even if the session that started the run does not.

These are raw results, kept whether or not a decision was made. Conclusions go in `ai-model-selection.md`, which should cite the run here. Only counts and costs are written; prompts and answers stay in each run's private out dir (default under `~/Library/Application Support/infinite-canvas/ai-test-runs/`).

Interview and practice-call runs in this log (stages `qa-*`, `typed-job-*`, `career-file-to-text`, `practice-call-plan`, the Listen matcher and the practice call) were run against code that moved to the separate Interview Helper repository on 2026-11-18. They are kept as history.

<!-- ai-test-run:backfill-ladder-control-a2 -->
### 2026-11-10 00:31 UTC · live bundle harness · application bundles · production (no stage overrides), noise-floor run A

- Status: **interrupted (SIGTERM at 2026-11-10 01:35:49 UTC: the launching session hit its weekly usage limit)** (updated 2026-11-10 01:35:49 UTC)
- Out dir: `~/Desktop/My Apps/infinite-canvas/tmp/claude-e2e/runs/ladder-control-a2`
- Bundles finished: 10 of 11 queued
- Recorded by: backfilled 2026-11-10 from the run folder (the harness had no journal yet); the session that launched it was deleted
- Stage requirements: 44/44 accepted, $12.973 (claude-sonnet-5-5)
- Stage convert: 3/52 accepted, $6.405 (claude-sonnet-5-5)
- Stage verify-correction: 27/64 accepted, $15.877 (claude-sonnet-5-5)
- Stage fit-correction: 22/24 accepted, $8.288 (claude-sonnet-5-5)
- Stage pick: 10/11 accepted, $4.758 (claude-opus-5-5)

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| ServiceNow, Inc. | 1 | 1 | 0 | $6.034 | bundle finished; accepted/calls: requirements 2/2; convert 0/5; verify-correction 2/6; fit-correction 3/3; pick 1/1 |
| Leap Tools | 1 | 1 | 0 | $7.517 | bundle finished; accepted/calls: requirements 4/4; convert 0/5; verify-correction 3/8; fit-correction 2/2; pick 1/1 |
| Decoda Health | 1 | 1 | 0 | $5.634 | bundle finished; accepted/calls: requirements 2/2; convert 0/5; verify-correction 5/7; pick 1/1 |
| Stripe | 1 | 1 | 0 | $4.348 | bundle finished; accepted/calls: requirements 2/2; convert 2/5; verify-correction 3/4; pick 1/1 |
| Affirm | 1 | 1 | 0 | $6.296 | bundle finished; accepted/calls: requirements 2/2; convert 0/5; verify-correction 2/7; fit-correction 3/4; pick 1/1 |
| Freed | 1 | 1 | 0 | $5.720 | bundle finished; accepted/calls: requirements 2/2; convert 1/5; verify-correction 1/4; fit-correction 3/3; pick 1/1 |
| Baseten | 1 | 1 | 0 | $4.696 | bundle finished; accepted/calls: requirements 2/2; convert 0/5; verify-correction 3/5; fit-correction 2/2; pick 1/1 |
| Faire | 1 | 1 | 0 | $7.986 | bundle finished; accepted/calls: requirements 4/4; convert 0/5; verify-correction 0/8; fit-correction 5/5; pick 1/1 |
| Exelixis | 1 | 1 | 0 | $9.035 | bundle finished; accepted/calls: requirements 9/9; convert 0/5; verify-correction 2/6; fit-correction 3/4; pick 1/1 |
| TRM Labs | 1 | 0 | 0 | $9.403 | unfinished when killed; accepted/calls: requirements 14/14; convert 0/2; verify-correction 2/3 |
| Remitly | 1 | 1 | 0 | $5.633 | bundle finished; accepted/calls: requirements 1/1; convert 0/5; verify-correction 4/6; fit-correction 1/1; pick 1/2 |

Recorded cost so far: $72.30.
<!-- /ai-test-run:backfill-ladder-control-a2 -->

<!-- ai-test-run:backfill-ladder-control-b2 -->
### 2026-11-10 00:31 UTC · live bundle harness · application bundles · production (no stage overrides), noise-floor run B

- Status: **interrupted (SIGTERM at 2026-11-10 01:35:49 UTC: the launching session hit its weekly usage limit)** (updated 2026-11-10 01:35:49 UTC)
- Out dir: `~/Desktop/My Apps/infinite-canvas/tmp/claude-e2e/runs/ladder-control-b2`
- Bundles finished: 9 of 13 queued
- Recorded by: backfilled 2026-11-10 from the run folder (the harness had no journal yet); the session that launched it was deleted
- Stage requirements: 41/41 accepted, $8.689 (claude-sonnet-5-5)
- Stage convert: 5/58 accepted, $7.605 (claude-sonnet-5-5)
- Stage verify-correction: 25/76 accepted, $19.846 (claude-sonnet-5-5)
- Stage fit-correction: 25/29 accepted, $10.530 (claude-sonnet-5-5)
- Stage pick: 9/9 accepted, $3.515 (claude-opus-5-5)

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| Affirm | 1 | 1 | 0 | $5.847 | bundle finished; accepted/calls: requirements 2/2; convert 0/5; verify-correction 3/6; fit-correction 2/3; pick 1/1 |
| ServiceNow, Inc. | 1 | 0 | 0 | $5.243 | unfinished when killed; accepted/calls: requirements 4/4; convert 0/4; verify-correction 2/6; fit-correction 2/2 |
| Stripe | 1 | 1 | 0 | $5.940 | bundle finished; accepted/calls: requirements 2/2; convert 0/5; verify-correction 4/8; fit-correction 1/1; pick 1/1 |
| Baseten | 1 | 0 | 0 | $4.693 | unfinished when killed; accepted/calls: requirements 2/2; convert 0/4; verify-correction 1/5; fit-correction 3/3 |
| Faire | 1 | 1 | 0 | $7.085 | bundle finished; accepted/calls: requirements 2/2; convert 0/5; verify-correction 1/8; fit-correction 3/4; pick 1/1 |
| TRM Labs | 1 | 0 | 1 | $0.495 | failed at requirements (CLAUDE_SAFEGUARD_BLOCKED); accepted/calls: requirements 2/2 |
| Fellow - AI Meeting Assistant | 1 | 0 | 0 | $4.754 | unfinished when killed; accepted/calls: requirements 5/5; convert 0/4; verify-correction 4/6 |
| Leap Tools | 1 | 1 | 0 | $7.475 | bundle finished; accepted/calls: requirements 4/4; convert 1/5; verify-correction 2/7; fit-correction 2/2; pick 1/1 |
| Exelixis | 1 | 1 | 0 | $7.138 | bundle finished; accepted/calls: requirements 6/6; convert 2/5; verify-correction 1/5; fit-correction 2/2; pick 1/1 |
| Freed | 1 | 1 | 0 | $9.021 | bundle finished; accepted/calls: requirements 3/3; convert 0/6; fit-correction 4/4; verify-correction 1/8; pick 1/1 |
| Decoda Health | 1 | 1 | 0 | $6.949 | bundle finished; accepted/calls: requirements 5/5; convert 1/5; verify-correction 1/5; fit-correction 2/3; pick 1/1 |
| Appian | 1 | 1 | 0 | $7.023 | bundle finished; accepted/calls: requirements 2/2; convert 1/5; verify-correction 0/5; fit-correction 4/5; pick 1/1 |
| Remitly | 1 | 1 | 0 | $4.786 | bundle finished; accepted/calls: requirements 2/2; convert 0/5; verify-correction 5/7; pick 1/1 |

Recorded cost so far: $76.45.
<!-- /ai-test-run:backfill-ladder-control-b2 -->

<!-- ai-test-run:backfill-ladder-req-haiku-medium -->
### 2026-11-10 00:47 UTC · live bundle harness · application bundles · requirements=haiku:medium

- Status: **interrupted (SIGTERM at 2026-11-10 01:35:49 UTC: the launching session hit its weekly usage limit)** (updated 2026-11-10 01:35:49 UTC)
- Out dir: `~/Desktop/My Apps/infinite-canvas/tmp/claude-e2e/runs/ladder-req-haiku-medium`
- Bundles finished: 3 of 12 queued
- Recorded by: backfilled 2026-11-10 from the run folder (the harness had no journal yet); the session that launched it was deleted
- Stage requirements: 74/78 accepted, $1.723 (claude-haiku-5-5)
- Stage convert: 3/33 accepted, $4.065 (claude-sonnet-5-5)
- Stage verify-correction: 18/40 accepted, $10.203 (claude-sonnet-5-5)
- Stage fit-correction: 8/10 accepted, $3.733 (claude-sonnet-5-5)
- Stage pick: 3/3 accepted, $1.235 (claude-opus-5-5)

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| Decoda Health | 1 | 0 | 0 | $3.619 | unfinished when killed; accepted/calls: requirements 7/7; convert 1/4; verify-correction 2/5; fit-correction 0/0 |
| TRM Labs | 1 | 0 | 0 | $0.719 | unfinished when killed; accepted/calls: requirements 15/15 |
| Fellow - AI Meeting Assistant | 1 | 0 | 0 | $1.815 | unfinished when killed; accepted/calls: requirements 6/6; convert 1/2; verify-correction 1/1 |
| Baseten | 1 | 0 | 0 | $1.622 | unfinished when killed; accepted/calls: requirements 4/4; convert 0/1; verify-correction 0/1; fit-correction 1/1 |
| ServiceNow, Inc. | 1 | 0 | 0 | $1.303 | unfinished when killed; accepted/calls: requirements 6/6; convert 0/1; verify-correction 0/1; fit-correction 1/1 |
| Affirm | 1 | 0 | 0 | $5.180 | unfinished when killed; accepted/calls: requirements 2/2; convert 0/4; verify-correction 2/9; fit-correction 1/2 |
| Leap Tools | 1 | 1 | 0 | $5.419 | bundle finished; accepted/calls: requirements 8/11; convert 0/5; verify-correction 3/5; fit-correction 2/2; pick 1/1 |
| Faire | 1 | 0 | 0 | $2.513 | unfinished when killed; accepted/calls: requirements 6/6; convert 0/2; verify-correction 0/3; fit-correction 1/1 |
| Appian | 1 | 1 | 0 | $5.095 | bundle finished; accepted/calls: requirements 4/4; convert 0/5; verify-correction 4/6; fit-correction 1/1; pick 1/1 |
| Freed | 1 | 0 | 0 | $2.323 | unfinished when killed; accepted/calls: requirements 8/8; convert 0/2; verify-correction 0/1; fit-correction 1/2 |
| Remitly | 1 | 0 | 0 | $1.935 | unfinished when killed; accepted/calls: requirements 6/7; convert 0/2; verify-correction 2/2 |
| Stripe | 1 | 1 | 0 | $4.648 | bundle finished; accepted/calls: requirements 2/2; convert 1/5; verify-correction 4/6; pick 1/1 |

Recorded cost so far: $36.19.
<!-- /ai-test-run:backfill-ladder-req-haiku-medium -->

<!-- ai-test-run:backfill-ladder-convert-haiku-medium -->
### 2026-11-10 00:47 UTC · live bundle harness · application bundles · convert=haiku:medium

- Status: **interrupted (SIGTERM at 2026-11-10 01:35:49 UTC: the launching session hit its weekly usage limit)** (updated 2026-11-10 01:35:49 UTC)
- Out dir: `~/Desktop/My Apps/infinite-canvas/tmp/claude-e2e/runs/ladder-convert-haiku-medium`
- Bundles finished: 0 of 12 queued
- Recorded by: backfilled 2026-11-10 from the run folder (the harness had no journal yet); the session that launched it was deleted
- Stage requirements: 28/28 accepted, $5.305 (claude-sonnet-5-5)
- Stage convert: 1/24 accepted, $0.563 (claude-haiku-5-5)
- Stage verify-correction: 11/26 accepted, $9.029 (claude-sonnet-5-5)
- Stage fit-correction: 7/9 accepted, $4.185 (claude-sonnet-5-5)
- Stage pick: 0/0 accepted, $0.000 ()

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| ServiceNow, Inc. | 1 | 0 | 0 | $1.303 | unfinished when killed; accepted/calls: requirements 2/2; convert 1/1 |
| Decoda Health | 1 | 0 | 0 | $3.528 | unfinished when killed; accepted/calls: requirements 3/3; convert 0/2; verify-correction 1/4; fit-correction 1/1 |
| Remitly | 1 | 0 | 0 | $1.576 | unfinished when killed; accepted/calls: requirements 2/2; convert 0/2; verify-correction 1/2 |
| Stripe | 1 | 0 | 0 | $4.320 | unfinished when killed; accepted/calls: requirements 2/2; convert 0/5; verify-correction 5/6; pick 0/0 |
| Fellow - AI Meeting Assistant | 1 | 0 | 0 | $1.098 | unfinished when killed; accepted/calls: requirements 3/3; convert 0/1; verify-correction 0/0 |
| Leap Tools | 1 | 0 | 0 | $4.793 | unfinished when killed; accepted/calls: requirements 3/3; convert 0/3; verify-correction 2/5; fit-correction 1/1 |
| TRM Labs | 1 | 0 | 1 | $0.176 | failed at requirements (CLAUDE_SAFEGUARD_BLOCKED); accepted/calls: requirements 1/1 |
| Baseten | 1 | 0 | 0 | $0.807 | unfinished when killed; accepted/calls: requirements 2/2; convert 0/1; verify-correction 0/0 |
| Exelixis | 1 | 0 | 0 | $4.375 | unfinished when killed; accepted/calls: requirements 3/3; convert 0/3; verify-correction 0/3; fit-correction 2/2 |
| Faire | 1 | 0 | 0 | $1.872 | unfinished when killed; accepted/calls: requirements 3/3; convert 0/1; verify-correction 0/1; fit-correction 1/1 |
| Affirm | 1 | 0 | 0 | $3.853 | unfinished when killed; accepted/calls: requirements 2/2; convert 0/2; verify-correction 1/3; fit-correction 1/3 |
| Freed | 1 | 0 | 0 | $2.837 | unfinished when killed; accepted/calls: requirements 2/2; convert 0/3; verify-correction 1/2; fit-correction 1/1 |

Recorded cost so far: $30.54.
<!-- /ai-test-run:backfill-ladder-convert-haiku-medium -->

<!-- ai-test-run:backfill-ladder-corr-haiku-medium-4 -->
### 2026-11-10 01:21 UTC · live bundle harness · application bundles · verify-correction=haiku:medium, fit-correction=haiku:medium (4 jobs)

- Status: **interrupted (SIGTERM at 2026-11-10 01:35:49 UTC: the launching session hit its weekly usage limit)** (updated 2026-11-10 01:35:49 UTC)
- Out dir: `~/Desktop/My Apps/infinite-canvas/tmp/claude-e2e/runs/ladder-corr-haiku-medium-4`
- Bundles finished: 0 of 4 queued
- Recorded by: backfilled 2026-11-10 from the run folder (the harness had no journal yet); the session that launched it was deleted
- Stage requirements: 14/14 accepted, $4.050 (claude-sonnet-5-5)
- Stage convert: 1/3 accepted, $0.379 (claude-sonnet-5-5)
- Stage verify-correction: 1/5 accepted, $1.075 (claude-haiku-5-5)
- Stage fit-correction: 1/1 accepted, $0.181 (claude-haiku-5-5)

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| Leap Tools | 1 | 0 | 0 | $4.561 | unfinished when killed; accepted/calls: requirements 8/8; convert 1/2; verify-correction 1/3 |
| Decoda Health | 1 | 0 | 1 | $0.000 | failed at requirements (CLAUDE_SAFEGUARD_BLOCKED); accepted/calls: requirements 0/0 |
| Stripe | 1 | 0 | 1 | $0.000 | failed at requirements (CLAUDE_SAFEGUARD_BLOCKED); accepted/calls: requirements 0/0 |
| Exelixis | 1 | 0 | 0 | $2.962 | unfinished when killed; accepted/calls: requirements 6/6; convert 0/1; verify-correction 0/2; fit-correction 1/1 |

Recorded cost so far: $7.523.
<!-- /ai-test-run:backfill-ladder-corr-haiku-medium-4 -->

<!-- ai-test-run:backfill-pick-five-8 -->
### 2026-11-09 23:00 UTC · claude-effort-ladder run · pick · haiku:low, haiku:medium, sonnet:low, sonnet:medium + production rerun

- Status: **finished (numbers from the session transcript)** (updated 2026-11-10 02:06:00 UTC)
- Records: 8 five-candidate prompts from the evidence archive (~/Desktop/Job Search/.local-ai/evidence-archive)
- Recorded by: backfilled 2026-11-10; raw result rows lost: they were written to the deleted session scratchpad. Numbers are as reported in that session, not recomputed

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| pick haiku:low and haiku:medium |  |  |  |  | invalid answers 12–25%; top-1 agreement with production about 33–43% |
| pick sonnet:low | 8 |  |  |  | top-1 agreement 3/8 |
| pick sonnet:medium | 8 |  |  |  | top-1 agreement 5/8 (62.5%); about half the cost of production |
| pick opus:high (production rerun) |  |  |  |  | top-1 agreement with the archived production answer 69% |

Recorded cost so far: $0.000.
- Note: Start time approximate.
<!-- /ai-test-run:backfill-pick-five-8 -->

<!-- ai-test-run:backfill-pick-five-24 -->
### 2026-11-10 00:00 UTC · claude-effort-ladder run · pick · sonnet:medium + production rerun

- Status: **finished (numbers from the session transcript)** (updated 2026-11-10 02:06:00 UTC)
- Records: 24 further five-candidate prompts (exact set not recoverable: the archive holds 39 five-candidate prompts)
- Recorded by: backfilled 2026-11-10; raw result rows lost: they were written to the deleted session scratchpad. Numbers are as reported in that session, not recomputed

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| pick sonnet:medium | 24 |  |  |  | top-1 agreement 48%: the 8-prompt result did not hold |
| pick opus:high (production rerun) | 24 |  |  |  | top-1 agreement 83% (noise floor for this set) |

Recorded cost so far: $0.000.
- Note: Start time approximate.
<!-- /ai-test-run:backfill-pick-five-24 -->

<!-- ai-test-run:backfill-pick-opus-low-sonnet-high-24 -->
### 2026-11-10 01:30 UTC · claude-effort-ladder run · pick · opus:low, sonnet:high

- Status: **unknown: the session reported the command finished, then hit its usage limit; no output survives** (updated 2026-11-10 02:06:00 UTC)
- Records: the same 24 prompts
- Recorded by: backfilled 2026-11-10; raw result rows lost: they were written to the deleted session scratchpad. Numbers are as reported in that session, not recomputed

No results yet.
- Note: Needs a rerun, with a production arm on the same prompts as the noise floor.
<!-- /ai-test-run:backfill-pick-opus-low-sonnet-high-24 -->

<!-- ai-test-run:2026-11-10T03-51-56-344Z-claude-effort-ladderrun-00acf2 -->
### 2026-11-10 03:51 UTC · claude-effort-ladder run · pick · opus:low

- Status: **finished** (updated 2026-11-10 03:52:09 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-pick-smoke`
- Command: `node scripts/claude-effort-ladder.mjs run --records ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-recovery/pick-smoke-1.jsonl --configs opus:low --reps 1 --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-pick-smoke --concurrency 1`
- Records: 1 from ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-recovery/pick-smoke-1.jsonl
- Reps: 1

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| pick opus:low | 1 | 1 | 0 | $0.420 | top-1 agreement with baseline 1/1 (100%) |

Recorded cost so far: $0.420.
<!-- /ai-test-run:2026-11-10T03-51-56-344Z-claude-effort-ladderrun-00acf2 -->

<!-- ai-test-run:2026-11-10T03-52-27-031Z-claude-effort-ladderrun-1086b4 -->
### 2026-11-10 03:52 UTC · claude-effort-ladder run · pick · sonnet:high, opus:high

- Status: **finished** (updated 2026-11-10 03:56:13 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-pick-sonnet-high-vs-production-24`
- Command: `node scripts/claude-effort-ladder.mjs run --records ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-recovery/pick-five-24.jsonl --configs sonnet:high,opus:high --reps 1 --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-pick-sonnet-high-vs-production-24 --concurrency 4`
- Records: 24 from ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-recovery/pick-five-24.jsonl
- Reps: 1

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| pick opus:high | 24 | 11 | 12 | $5.494 | top-1 agreement with baseline 8/11 (72.7%), 13 unparsed |
| pick sonnet:high | 24 | 12 | 12 | $2.855 | top-1 agreement with baseline 8/12 (66.7%), 12 unparsed |

Recorded cost so far: $8.349.
<!-- /ai-test-run:2026-11-10T03-52-27-031Z-claude-effort-ladderrun-1086b4 -->

<!-- ai-test-run:2026-11-10T03-55-35-652Z-livebundleharness-6aad45 -->
### 2026-11-10 03:55 UTC · live bundle harness · application bundles · convert=haiku:high

- Status: **interrupted (SIGTERM) before finishing; rows above are complete up to that point** (updated 2026-11-10 04:36:11 UTC)
- Out dir: `~/Desktop/My Apps/infinite-canvas/tmp/claude-e2e/runs/ladder-convert-haiku-high-4`
- Command: `INFINITE_CANVAS_STAGE_PROFILES=convert=haiku:high node scripts/live-bundle-harness.mjs --job tmp/claude-e2e/runs/ladder-control-a2/canvas/.local-ai/jobs/b751c4cd-d624-427c-bf96-8e24fc543ca3/input.json --job tmp/claude-e2e/runs/ladder-control-a2/canvas/.local-ai/jobs/2e98b0b7-105c-4928-abdc-374e0fe8603a/input.json --job tmp/claude-e2e/runs/ladder-control-a2/canvas/.local-ai/jobs/abc74539-766a-4dd8-871f-37ff084860a2/input.json --job tmp/claude-e2e/runs/ladder-control-a2/canvas/.local-ai/jobs/97d7410f-df35-42b1-bd32-14d0d46505de/input.json --max-minutes 150 --out tmp/claude-e2e/runs/ladder-convert-haiku-high-4`
- Jobs: 4
- Candidates: default

No results yet.
<!-- /ai-test-run:2026-11-10T03-55-35-652Z-livebundleharness-6aad45 -->

<!-- ai-test-run:2026-11-10T03-55-35-652Z-livebundleharness-f4bc10 -->
### 2026-11-10 03:55 UTC · live bundle harness · application bundles · verify-correction=haiku:medium,fit-correction=haiku:medium

- Status: **interrupted (SIGTERM) before finishing; rows above are complete up to that point** (updated 2026-11-10 04:36:11 UTC)
- Out dir: `~/Desktop/My Apps/infinite-canvas/tmp/claude-e2e/runs/ladder-corr-haiku-medium-4b`
- Command: `INFINITE_CANVAS_STAGE_PROFILES=verify-correction=haiku:medium,fit-correction=haiku:medium node scripts/live-bundle-harness.mjs --job tmp/claude-e2e/runs/ladder-control-a2/canvas/.local-ai/jobs/b751c4cd-d624-427c-bf96-8e24fc543ca3/input.json --job tmp/claude-e2e/runs/ladder-control-a2/canvas/.local-ai/jobs/2e98b0b7-105c-4928-abdc-374e0fe8603a/input.json --job tmp/claude-e2e/runs/ladder-control-a2/canvas/.local-ai/jobs/abc74539-766a-4dd8-871f-37ff084860a2/input.json --job tmp/claude-e2e/runs/ladder-control-a2/canvas/.local-ai/jobs/97d7410f-df35-42b1-bd32-14d0d46505de/input.json --max-minutes 150 --out tmp/claude-e2e/runs/ladder-corr-haiku-medium-4b`
- Jobs: 4
- Candidates: default

No results yet.
<!-- /ai-test-run:2026-11-10T03-55-35-652Z-livebundleharness-f4bc10 -->

<!-- ai-test-run:2026-11-10T04-07-35-266Z-blindjudgeraw-answercheck-b26bf3 -->
### 2026-11-10 04:07 UTC · blind judge + raw-answer check · requirements · haiku:medium vs production A and B (2026-11-09 live arms)

- Status: **finished: Haiku medium FAILS (requirement text replaced by IDs)** (updated 2026-11-10 04:07:35 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-requirements-judge`
- Judge: 3 Offload report jobs on DeepSeek Flash (OpenAI and Anthropic API credit exhausted), blind X/Y/Z, review packets passed 37/37 quotes
- Restarts: Haiku 2.3 requirement epochs per job vs 1.2 and 1.4 for production (9 jobs)
- Stage cost: Haiku about $1.7 vs about $13 for production (all jobs in the arms)

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| production A (sonnet:high) | 764 | 764 | 0 |  | ID-as-text 0 of 375+389 items across both production runs |
| haiku:medium | 585 | 394 | 191 |  | ID-as-text in 191 of 585 items (33%), 20 of 78 accepted answers; the app validator accepted all of them |
| judge mean score prodA | 9 |  |  | $0.030 | 6.4/10 (8,8,7,2,6,8,7,4,8) |
| judge mean score prodB | 9 |  |  | $0.030 | 7.1/10 (8,7,2,8,8,9,8,6,8) |
| judge mean score haiku:medium | 9 |  |  | $0.020 | 5.8/10 (5,5,5,3,9,5,9,2,9); ID-text sets scored 5,5,2 |

Recorded cost so far: $0.080.
- Note: Caveat: extract.mjs kept only the last epoch, but a restart can resume from a later source unit, so a few sets (production too) were judged truncated. The ID-text defect does not depend on this.
- Note: Next rung: requirements haiku:high on 4 jobs. Haiku low skipped: it is tested only when medium passes. Validator gap: requirements accept an ID as requirement text.
<!-- /ai-test-run:2026-11-10T04-07-35-266Z-blindjudgeraw-answercheck-b26bf3 -->

<!-- ai-test-run:2026-11-10T04-07-35-308Z-claude-effort-ladderrunpartial-8f89e7 -->
### 2026-11-10 04:07 UTC · claude-effort-ladder run (partial) · pick · sonnet:high vs opus:high production rerun, 24 five-candidate prompts

- Status: **partial: 24 of 48 calls hit the Claude session limit; gap-fill queued for 07:05 UTC** (updated 2026-11-10 04:07:35 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-pick-sonnet-high-vs-production-24`

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| pick opus:high (production rerun) | 12 | 11 | 0 | $5.494 | top-1 agreement 8/11 (73%) with the archived production answer |
| pick sonnet:high | 12 | 11 | 0 | $2.855 | top-1 agreement 8/12 (67%); 1 reply not JSON; $0.238 vs $0.458 a call (48% cheaper) |

Recorded cost so far: $8.349.
- Note: Opus low not run: a smoke call cost $0.42 vs $0.46 production because page-image input dominates, so it cannot save money.
- Note: Too few rows to decide; rerun the same command to fill the failed cells.
<!-- /ai-test-run:2026-11-10T04-07-35-308Z-claude-effort-ladderrunpartial-8f89e7 -->

<!-- ai-test-run:2026-11-10T04-07-57-750Z-livebundleharness-3ae523 -->
### 2026-11-10 04:07 UTC · live bundle harness · application bundles · requirements=haiku:high

- Status: **finished** (updated 2026-11-10 04:35:19 UTC)
- Out dir: `~/Desktop/My Apps/infinite-canvas/tmp/claude-e2e/runs/ladder-req-haiku-high-4`
- Command: `INFINITE_CANVAS_STAGE_PROFILES=requirements=haiku:high node scripts/live-bundle-harness.mjs --job tmp/claude-e2e/runs/ladder-control-a2/canvas/.local-ai/jobs/9781acec-1ea9-4189-9972-b829e535b827/input.json --job tmp/claude-e2e/runs/ladder-control-a2/canvas/.local-ai/jobs/2e98b0b7-105c-4928-abdc-374e0fe8603a/input.json --job tmp/claude-e2e/runs/ladder-control-a2/canvas/.local-ai/jobs/13bee2d0-1d07-4689-8508-7fbbe6a500f8/input.json --job tmp/claude-e2e/runs/ladder-control-a2/canvas/.local-ai/jobs/97d7410f-df35-42b1-bd32-14d0d46505de/input.json --max-minutes 150 --out tmp/claude-e2e/runs/ladder-req-haiku-high-4`
- Jobs: 4
- Candidates: default
- Bundles finished: 4 of 4 queued

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| Affirm | 1 | 1 | 0 | $8.325 | bundle finished; accepted/calls: requirements 2/2 haiku-5-5; convert 1/5 sonnet-5-5; verify-correction 1/9 sonnet-5-5; fit-correction 3/3 sonnet-5-5; pick 1/1 opus-5-5 |
| Leap Tools | 1 | 1 | 0 | $7.293 | bundle finished; accepted/calls: requirements 11/11 haiku-5-5; convert 0/5 sonnet-5-5; verify-correction 1/8 sonnet-5-5; fit-correction 4/4 sonnet-5-5; pick 1/1 opus-5-5 |
| ServiceNow, Inc. | 1 | 1 | 0 | $5.079 | bundle finished; accepted/calls: requirements 6/6 haiku-5-5; convert 0/5 sonnet-5-5; verify-correction 3/5 sonnet-5-5; fit-correction 2/2 sonnet-5-5; pick 1/1 opus-5-5 |
| Freed | 1 | 1 | 0 | $6.408 | bundle finished; accepted/calls: requirements 3/3 haiku-5-5; convert 0/5 sonnet-5-5; verify-correction 1/6 sonnet-5-5; fit-correction 4/4 sonnet-5-5; pick 1/1 opus-5-5 |

Recorded cost so far: $27.10.
<!-- /ai-test-run:2026-11-10T04-07-57-750Z-livebundleharness-3ae523 -->

<!-- ai-test-run:2026-11-10T04-16-40-037Z-claude-effort-ladderrun-98deb4 -->
### 2026-11-10 04:16 UTC · claude-effort-ladder run · pick · sonnet:high, opus:high

- Status: **finished** (updated 2026-11-10 04:20:24 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-pick-sonnet-high-vs-production-24`
- Command: `node scripts/claude-effort-ladder.mjs run --records ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-recovery/pick-five-24.jsonl --configs sonnet:high,opus:high --reps 1 --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-pick-sonnet-high-vs-production-24 --concurrency 4`
- Records: 24 from ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-recovery/pick-five-24.jsonl
- Reps: 1

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| pick opus:high | 36 | 23 | 12 | $10.90 | top-1 agreement with baseline 14/22 (63.6%), 14 unparsed |
| pick sonnet:high | 36 | 24 | 12 | $5.665 | top-1 agreement with baseline 12/23 (52.2%), 13 unparsed |

Recorded cost so far: $16.57.
<!-- /ai-test-run:2026-11-10T04-16-40-037Z-claude-effort-ladderrun-98deb4 -->

<!-- ai-test-run:2026-11-10T04-16-49-793Z-livebundleharness-51aab7 -->
### 2026-11-10 04:16 UTC · live bundle harness · application bundles · verify-correction=haiku:medium,fit-correction=haiku:medium

- Status: **finished** (updated 2026-11-10 04:35:52 UTC)
- Out dir: `~/Desktop/My Apps/infinite-canvas/tmp/claude-e2e/runs/ladder-corr-haiku-medium-4b-exelixis`
- Command: `INFINITE_CANVAS_STAGE_PROFILES=verify-correction=haiku:medium,fit-correction=haiku:medium node scripts/live-bundle-harness.mjs --job tmp/claude-e2e/runs/ladder-control-a2/canvas/.local-ai/jobs/b751c4cd-d624-427c-bf96-8e24fc543ca3/input.json --max-minutes 150 --out tmp/claude-e2e/runs/ladder-corr-haiku-medium-4b-exelixis`
- Jobs: 1
- Candidates: default
- Bundles finished: 1 of 1 queued

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| Exelixis | 1 | 1 | 0 | $6.503 | bundle finished; accepted/calls: requirements 8/8 sonnet-5-5; convert 0/5 sonnet-5-5; verify-correction 3/5 haiku-5-5; fit-correction 2/3 haiku-5-5; pick 1/1 opus-5-5 |

Recorded cost so far: $6.503.
<!-- /ai-test-run:2026-11-10T04-16-49-793Z-livebundleharness-51aab7 -->

<!-- ai-test-run:2026-11-10T04-16-49-793Z-livebundleharness-1af9e2 -->
### 2026-11-10 04:16 UTC · live bundle harness · application bundles · convert=haiku:high

- Status: **interrupted (SIGTERM) before finishing; rows above are complete up to that point** (updated 2026-11-10 05:22:50 UTC)
- Out dir: `~/Desktop/My Apps/infinite-canvas/tmp/claude-e2e/runs/ladder-convert-haiku-high-4-exelixis`
- Command: `INFINITE_CANVAS_STAGE_PROFILES=convert=haiku:high node scripts/live-bundle-harness.mjs --job tmp/claude-e2e/runs/ladder-control-a2/canvas/.local-ai/jobs/b751c4cd-d624-427c-bf96-8e24fc543ca3/input.json --max-minutes 150 --out tmp/claude-e2e/runs/ladder-convert-haiku-high-4-exelixis`
- Jobs: 1
- Candidates: default
- Bundles finished: 0 of 1 queued

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| Exelixis | 1 | 0 | 0 | $9.701 | running; accepted/calls: requirements 3/3 sonnet-5-5; convert 0/5 haiku-5-5; verify-correction 1/8 sonnet-5-5; fit-correction 3/3 sonnet-5-5 |

Recorded cost so far: $9.701.
<!-- /ai-test-run:2026-11-10T04-16-49-793Z-livebundleharness-1af9e2 -->

<!-- ai-test-run:2026-11-10T04-20-48-928Z-claude-effort-ladderruncompletepaired-fac537 -->
### 2026-11-10 04:20 UTC · claude-effort-ladder run (complete, paired) · pick · sonnet:high vs opus:high production rerun, 24 five-candidate prompts

- Status: **finished: Sonnet high FAILS; pick stays Opus high** (updated 2026-11-10 04:20:48 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-pick-sonnet-high-vs-production-24`

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| pick opus:high (production rerun) | 22 | 22 | 0 | $10.90 | top-1 agreement with archived production 14/22 (64%) = noise floor |
| pick sonnet:high | 22 | 22 | 0 | $5.665 | top-1 agreement with archived production 11/22 (50%); with the production rerun 9/22 (41%); $0.24 vs $0.45 a call |

Recorded cost so far: $16.57.
- Note: 22 prompts where both arms gave a parseable ranking. Same pattern as Sonnet medium on the earlier 24 (48% vs 83%): Sonnet sits 14–35 points under production.
- Note: Opus low/medium cannot save money (page-image input dominates cost), so no cheaper setting remains: pick is settled at Opus high.
<!-- /ai-test-run:2026-11-10T04-20-48-928Z-claude-effort-ladderruncompletepaired-fac537 -->

<!-- ai-test-run:2026-11-10T04-35-41-486Z-raw-answercheck-0a6ba3 -->
### 2026-11-10 04:35 UTC · raw-answer check · requirements · haiku:high live arm, 4 jobs (Affirm, Leap Tools, ServiceNow, Freed)

- Status: **finished: Haiku high FAILS (ID as requirement text in 44% of items)** (updated 2026-11-10 04:35:41 UTC)
- Out dir: `~/Desktop/My Apps/infinite-canvas/tmp/claude-e2e/runs/ladder-req-haiku-high-4`

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| haiku:high | 170 | 96 | 74 | $0.433 | ID-as-text in 74 of 170 items (44%); 22/22 answers accepted (validator gap); 8 epochs over 4 jobs |

Recorded cost so far: $0.433.
- Note: Worse than Haiku medium (33%); production 0 of 764. Next rung: requirements=sonnet:low on the same 4 jobs.
<!-- /ai-test-run:2026-11-10T04-35-41-486Z-raw-answercheck-0a6ba3 -->

<!-- ai-test-run:2026-11-10T04-35-42-005Z-livebundleharness-21959b -->
### 2026-11-10 04:35 UTC · live bundle harness · application bundles · requirements=sonnet:low

- Status: **interrupted (SIGTERM) before finishing; rows above are complete up to that point** (updated 2026-11-10 05:22:49 UTC)
- Out dir: `~/Desktop/My Apps/infinite-canvas/tmp/claude-e2e/runs/ladder-req-sonnet-low-4`
- Command: `INFINITE_CANVAS_STAGE_PROFILES=requirements=sonnet:low node scripts/live-bundle-harness.mjs --job tmp/claude-e2e/runs/ladder-control-a2/canvas/.local-ai/jobs/9781acec-1ea9-4189-9972-b829e535b827/input.json --job tmp/claude-e2e/runs/ladder-control-a2/canvas/.local-ai/jobs/2e98b0b7-105c-4928-abdc-374e0fe8603a/input.json --job tmp/claude-e2e/runs/ladder-control-a2/canvas/.local-ai/jobs/13bee2d0-1d07-4689-8508-7fbbe6a500f8/input.json --job tmp/claude-e2e/runs/ladder-control-a2/canvas/.local-ai/jobs/97d7410f-df35-42b1-bd32-14d0d46505de/input.json --max-minutes 150 --out tmp/claude-e2e/runs/ladder-req-sonnet-low-4`
- Jobs: 4
- Candidates: default
- Bundles finished: 0 of 4 queued

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| Affirm | 1 | 0 | 0 | $3.544 | running; accepted/calls: requirements 2/2 sonnet-5-5; convert 0/4 sonnet-5-5; verify-correction 3/5 sonnet-5-5; fit-correction 1/1 sonnet-5-5 |
| Leap Tools | 1 | 0 | 0 | $4.022 | running; accepted/calls: requirements 4/4 sonnet-5-5; convert 0/3 sonnet-5-5; verify-correction 1/2 sonnet-5-5; fit-correction 1/2 sonnet-5-5 |
| ServiceNow, Inc. | 1 | 0 | 0 | $2.561 | running; accepted/calls: requirements 4/4 sonnet-5-5; convert 0/2 sonnet-5-5; verify-correction 2/3 sonnet-5-5 |
| Freed | 1 | 0 | 0 | $2.821 | running; accepted/calls: requirements 3/3 sonnet-5-5; convert 0/1 sonnet-5-5; verify-correction 0/2 sonnet-5-5; fit-correction 1/2 sonnet-5-5 |

Recorded cost so far: $12.95.
<!-- /ai-test-run:2026-11-10T04-35-42-005Z-livebundleharness-21959b -->

<!-- ai-test-run:2026-11-10T04-36-29-346Z-livebundleharness-e52f40 -->
### 2026-11-10 04:36 UTC · live bundle harness · application bundles · verify-correction=haiku:medium,fit-correction=haiku:medium

- Status: **interrupted (SIGTERM) before finishing; rows above are complete up to that point** (updated 2026-11-10 05:22:49 UTC)
- Out dir: `~/Desktop/My Apps/infinite-canvas/tmp/claude-e2e/runs/ladder-corr-haiku-medium-3`
- Command: `INFINITE_CANVAS_STAGE_PROFILES=verify-correction=haiku:medium,fit-correction=haiku:medium node scripts/live-bundle-harness.mjs --job tmp/claude-e2e/runs/ladder-control-a2/canvas/.local-ai/jobs/2e98b0b7-105c-4928-abdc-374e0fe8603a/input.json --job tmp/claude-e2e/runs/ladder-control-a2/canvas/.local-ai/jobs/abc74539-766a-4dd8-871f-37ff084860a2/input.json --job tmp/claude-e2e/runs/ladder-control-a2/canvas/.local-ai/jobs/97d7410f-df35-42b1-bd32-14d0d46505de/input.json --max-minutes 150 --out tmp/claude-e2e/runs/ladder-corr-haiku-medium-3`
- Jobs: 3
- Candidates: default
- Bundles finished: 0 of 2 queued

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| Leap Tools | 1 | 0 | 0 | $4.133 | running; accepted/calls: requirements 4/4 sonnet-5-5; convert 0/3 sonnet-5-5; fit-correction 1/3 haiku-5-5; verify-correction 1/4 haiku-5-5 |
| Freed | 1 | 0 | 0 | $2.362 | running; accepted/calls: requirements 4/4 sonnet-5-5; convert 0/1 sonnet-5-5; verify-correction 0/1 haiku-5-5; fit-correction 1/3 haiku-5-5 |

Recorded cost so far: $6.495.
<!-- /ai-test-run:2026-11-10T04-36-29-346Z-livebundleharness-e52f40 -->

<!-- ai-test-run:2026-11-10T04-36-29-346Z-livebundleharness-f1b969 -->
### 2026-11-10 04:36 UTC · live bundle harness · application bundles · convert=haiku:high

- Status: **interrupted (SIGTERM) before finishing; rows above are complete up to that point** (updated 2026-11-10 05:22:49 UTC)
- Out dir: `~/Desktop/My Apps/infinite-canvas/tmp/claude-e2e/runs/ladder-convert-haiku-high-3`
- Command: `INFINITE_CANVAS_STAGE_PROFILES=convert=haiku:high node scripts/live-bundle-harness.mjs --job tmp/claude-e2e/runs/ladder-control-a2/canvas/.local-ai/jobs/2e98b0b7-105c-4928-abdc-374e0fe8603a/input.json --job tmp/claude-e2e/runs/ladder-control-a2/canvas/.local-ai/jobs/abc74539-766a-4dd8-871f-37ff084860a2/input.json --job tmp/claude-e2e/runs/ladder-control-a2/canvas/.local-ai/jobs/97d7410f-df35-42b1-bd32-14d0d46505de/input.json --max-minutes 150 --out tmp/claude-e2e/runs/ladder-convert-haiku-high-3`
- Jobs: 3
- Candidates: default
- Bundles finished: 0 of 2 queued

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| Leap Tools | 1 | 0 | 0 | $2.292 | running; accepted/calls: requirements 3/3 sonnet-5-5; convert 0/2 haiku-5-5; verify-correction 1/1 sonnet-5-5 |
| Freed | 1 | 0 | 0 | $0.973 | running; accepted/calls: requirements 3/3 sonnet-5-5; convert 0/1 haiku-5-5; verify-correction 0/0 |

Recorded cost so far: $3.265.
<!-- /ai-test-run:2026-11-10T04-36-29-346Z-livebundleharness-f1b969 -->

<!-- ai-test-run:2026-11-10T05-23-10-690Z-livebundleharness-160929 -->
### 2026-11-10 05:23 UTC · live bundle harness · application bundles · requirements=sonnet:low

- Status: **finished** (updated 2026-11-10 05:35:55 UTC)
- Out dir: `~/Desktop/My Apps/infinite-canvas/tmp/claude-e2e/runs/ladder-req-sonnet-low-4`
- Command: `INFINITE_CANVAS_STAGE_PROFILES=requirements=sonnet:low node scripts/live-bundle-harness.mjs --retry 07bbf0d3-050b-4631-90bb-d05950fb504c --retry bc8c8fa6-63a8-41a5-a758-52cab121018b --retry f532d641-0285-475e-8d47-e778d1bcf6a3 --retry a06fbe85-bf16-4d3f-b37a-8f117b27fb56 --max-minutes 150 --out tmp/claude-e2e/runs/ladder-req-sonnet-low-4`
- Jobs: 4
- Candidates: default
- Bundles finished: 4 of 4 queued

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| Affirm | 1 | 1 | 0 | $4.781 | bundle finished; accepted/calls: requirements 2/2 sonnet-5-5; convert 0/5 sonnet-5-5; verify-correction 3/6 sonnet-5-5; fit-correction 2/2 sonnet-5-5; pick 1/1 opus-5-5 |
| Leap Tools | 1 | 1 | 0 | $7.646 | bundle finished; accepted/calls: requirements 4/4 sonnet-5-5; convert 1/5 sonnet-5-5; verify-correction 2/5 sonnet-5-5; fit-correction 2/4 sonnet-5-5; pick 1/1 opus-5-5 |
| ServiceNow, Inc. | 1 | 1 | 0 | $6.720 | bundle finished; accepted/calls: requirements 4/4 sonnet-5-5; convert 0/5 sonnet-5-5; verify-correction 2/6 sonnet-5-5; fit-correction 3/4 sonnet-5-5; pick 1/1 opus-5-5 |
| Freed | 1 | 1 | 0 | $7.530 | bundle finished; accepted/calls: requirements 3/3 sonnet-5-5; convert 1/5 sonnet-5-5; verify-correction 0/6 sonnet-5-5; fit-correction 4/5 sonnet-5-5; pick 1/1 opus-5-5 |

Recorded cost so far: $26.68.
<!-- /ai-test-run:2026-11-10T05-23-10-690Z-livebundleharness-160929 -->

<!-- ai-test-run:2026-11-10T05-23-10-690Z-livebundleharness-d1f89b -->
### 2026-11-10 05:23 UTC · live bundle harness · application bundles · verify-correction=haiku:medium,fit-correction=haiku:medium

- Status: **finished** (updated 2026-11-10 05:33:48 UTC)
- Out dir: `~/Desktop/My Apps/infinite-canvas/tmp/claude-e2e/runs/ladder-corr-haiku-medium-3`
- Command: `INFINITE_CANVAS_STAGE_PROFILES=verify-correction=haiku:medium,fit-correction=haiku:medium node scripts/live-bundle-harness.mjs --retry 9fe8cef9-8f81-4e3b-97c5-6bdb8d3c4511 --retry 11732720-6e7f-4095-9188-7e52bfe03ef7 --max-minutes 150 --out tmp/claude-e2e/runs/ladder-corr-haiku-medium-3`
- Jobs: 2
- Candidates: default
- Bundles finished: 2 of 2 queued

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| Leap Tools | 1 | 1 | 0 | $6.548 | bundle finished; accepted/calls: requirements 4/4 sonnet-5-5; convert 0/5 sonnet-5-5; fit-correction 2/5 haiku-5-5; verify-correction 3/7 haiku-5-5; pick 1/1 opus-5-5 |
| Freed | 1 | 1 | 0 | $5.803 | bundle finished; accepted/calls: requirements 4/4 sonnet-5-5; convert 0/5 sonnet-5-5; verify-correction 1/4 haiku-5-5; fit-correction 3/7 haiku-5-5; pick 1/1 opus-5-5 |

Recorded cost so far: $12.35.
<!-- /ai-test-run:2026-11-10T05-23-10-690Z-livebundleharness-d1f89b -->

<!-- ai-test-run:2026-11-10T05-23-10-690Z-livebundleharness-cea992 -->
### 2026-11-10 05:23 UTC · live bundle harness · application bundles · convert=haiku:high

- Status: **finished** (updated 2026-11-10 05:25:43 UTC)
- Out dir: `~/Desktop/My Apps/infinite-canvas/tmp/claude-e2e/runs/ladder-convert-haiku-high-4-exelixis`
- Command: `INFINITE_CANVAS_STAGE_PROFILES=convert=haiku:high node scripts/live-bundle-harness.mjs --retry 5511f505-5bc8-4c40-8196-989f7aaf66c6 --max-minutes 150 --out tmp/claude-e2e/runs/ladder-convert-haiku-high-4-exelixis`
- Jobs: 1
- Candidates: default
- Bundles finished: 1 of 1 queued

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| Exelixis | 1 | 1 | 0 | $11.55 | bundle finished; accepted/calls: requirements 3/3 sonnet-5-5; convert 0/5 haiku-5-5; verify-correction 1/9 sonnet-5-5; fit-correction 4/4 sonnet-5-5; pick 1/1 opus-5-5 |

Recorded cost so far: $11.55.
<!-- /ai-test-run:2026-11-10T05-23-10-690Z-livebundleharness-cea992 -->

<!-- ai-test-run:2026-11-10T05-23-10-690Z-livebundleharness-cc07fc -->
### 2026-11-10 05:23 UTC · live bundle harness · application bundles · convert=haiku:high

- Status: **finished** (updated 2026-11-10 05:49:58 UTC)
- Out dir: `~/Desktop/My Apps/infinite-canvas/tmp/claude-e2e/runs/ladder-convert-haiku-high-3`
- Command: `INFINITE_CANVAS_STAGE_PROFILES=convert=haiku:high node scripts/live-bundle-harness.mjs --retry a6a506e5-70dc-4d2e-92bd-4012e3085165 --retry e1972e5d-63ec-404d-a92c-1e23b48f566c --max-minutes 150 --out tmp/claude-e2e/runs/ladder-convert-haiku-high-3`
- Jobs: 2
- Candidates: default
- Bundles finished: 2 of 2 queued

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| Leap Tools | 1 | 1 | 0 | $7.272 | bundle finished; accepted/calls: requirements 3/3 sonnet-5-5; convert 0/5 haiku-5-5; verify-correction 3/6 sonnet-5-5; fit-correction 2/2 sonnet-5-5; pick 1/1 opus-5-5 |
| Freed | 1 | 1 | 0 | $8.541 | bundle finished; accepted/calls: requirements 3/3 sonnet-5-5; convert 0/5 haiku-5-5; verify-correction 1/5 sonnet-5-5; fit-correction 4/4 sonnet-5-5; pick 1/1 opus-5-5 |

Recorded cost so far: $15.81.
<!-- /ai-test-run:2026-11-10T05-23-10-690Z-livebundleharness-cc07fc -->

<!-- ai-test-run:2026-11-10T05-34-28-964Z-armcomparisoncompare-armsmjs-08d8bf -->
### 2026-11-10 05:34 UTC · arm comparison (compare-arms.mjs) · verify-correction, fit-correction · both at haiku:medium vs production A/B, 3 jobs (Exelixis, Leap Tools, Freed)

- Status: **finished: verify-correction passes first gate; fit-correction FAILS** (updated 2026-11-10 05:34:28 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-recovery`

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| verify-correction prodA | 18 | 6 |  | $4.630 | 33% accepted |
| verify-correction prodB | 20 | 4 |  | $6.110 | 20% accepted |
| verify-correction haiku:medium | 16 | 7 |  | $2.470 | 44% accepted, about half the cost |
| fit-correction prodA | 9 | 8 |  | $2.990 | 89% |
| fit-correction prodB | 8 | 8 |  | $3.480 | 100% |
| fit-correction haiku:medium | 15 | 7 |  | $2.760 | 47%: fails, retries eat the saving |
| bundles prodA | 3 | 3 |  | $22.27 |  |
| bundles prodB | 3 | 3 |  | $23.63 |  |
| bundles haiku:medium corrections | 3 | 3 |  | $18.85 |  |

Recorded cost so far: $87.19.
- Note: Faire skipped (employer verification incomplete). Next: verify-correction=haiku:low and fit-correction=haiku:high as separate 4-job arms; blind judge of final bundles.
<!-- /ai-test-run:2026-11-10T05-34-28-964Z-armcomparisoncompare-armsmjs-08d8bf -->

<!-- ai-test-run:2026-11-10T05-34-29-301Z-livebundleharness-5e0a4e -->
### 2026-11-10 05:34 UTC · live bundle harness · application bundles · fit-correction=haiku:high

- Status: **finished** (updated 2026-11-10 06:02:21 UTC)
- Out dir: `~/Desktop/My Apps/infinite-canvas/tmp/claude-e2e/runs/ladder-fit-haiku-high-4`
- Command: `INFINITE_CANVAS_STAGE_PROFILES=fit-correction=haiku:high node scripts/live-bundle-harness.mjs --job tmp/claude-e2e/runs/ladder-control-a2/canvas/.local-ai/jobs/b751c4cd-d624-427c-bf96-8e24fc543ca3/input.json --job tmp/claude-e2e/runs/ladder-control-a2/canvas/.local-ai/jobs/2e98b0b7-105c-4928-abdc-374e0fe8603a/input.json --job tmp/claude-e2e/runs/ladder-control-a2/canvas/.local-ai/jobs/97d7410f-df35-42b1-bd32-14d0d46505de/input.json --job tmp/claude-e2e/runs/ladder-control-a2/canvas/.local-ai/jobs/9781acec-1ea9-4189-9972-b829e535b827/input.json --max-minutes 150 --out tmp/claude-e2e/runs/ladder-fit-haiku-high-4`
- Jobs: 4
- Candidates: default
- Bundles finished: 4 of 4 queued

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| Exelixis | 1 | 1 | 0 | $10.97 | bundle finished; accepted/calls: requirements 9/9 sonnet-5-5; convert 0/5 sonnet-5-5; verify-correction 2/9 sonnet-5-5; fit-correction 3/6 haiku-5-5; pick 1/1 opus-5-5 |
| Leap Tools | 1 | 1 | 0 | $7.641 | bundle finished; accepted/calls: requirements 4/4 sonnet-5-5; convert 1/5 sonnet-5-5; verify-correction 2/6 sonnet-5-5; fit-correction 2/4 haiku-5-5; pick 1/1 opus-5-5 |
| Freed | 1 | 1 | 0 | $7.287 | bundle finished; accepted/calls: requirements 6/6 sonnet-5-5; convert 1/5 sonnet-5-5; verify-correction 0/3 sonnet-5-5; fit-correction 4/7 haiku-5-5; pick 1/1 opus-5-5 |
| Affirm | 1 | 1 | 0 | $6.566 | bundle finished; accepted/calls: requirements 2/2 sonnet-5-5; convert 0/5 sonnet-5-5; verify-correction 2/6 sonnet-5-5; fit-correction 2/7 haiku-5-5; pick 1/1 opus-5-5 |

Recorded cost so far: $32.47.
<!-- /ai-test-run:2026-11-10T05-34-29-301Z-livebundleharness-5e0a4e -->

<!-- ai-test-run:2026-11-10T05-34-29-301Z-livebundleharness-0fee58 -->
### 2026-11-10 05:34 UTC · live bundle harness · application bundles · verify-correction=haiku:low

- Status: **finished** (updated 2026-11-10 05:59:28 UTC)
- Out dir: `~/Desktop/My Apps/infinite-canvas/tmp/claude-e2e/runs/ladder-verify-haiku-low-4`
- Command: `INFINITE_CANVAS_STAGE_PROFILES=verify-correction=haiku:low node scripts/live-bundle-harness.mjs --job tmp/claude-e2e/runs/ladder-control-a2/canvas/.local-ai/jobs/b751c4cd-d624-427c-bf96-8e24fc543ca3/input.json --job tmp/claude-e2e/runs/ladder-control-a2/canvas/.local-ai/jobs/2e98b0b7-105c-4928-abdc-374e0fe8603a/input.json --job tmp/claude-e2e/runs/ladder-control-a2/canvas/.local-ai/jobs/97d7410f-df35-42b1-bd32-14d0d46505de/input.json --job tmp/claude-e2e/runs/ladder-control-a2/canvas/.local-ai/jobs/9781acec-1ea9-4189-9972-b829e535b827/input.json --max-minutes 150 --out tmp/claude-e2e/runs/ladder-verify-haiku-low-4`
- Jobs: 4
- Candidates: default
- Bundles finished: 4 of 4 queued

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| Exelixis | 1 | 1 | 0 | $8.215 | bundle finished; accepted/calls: requirements 9/9 sonnet-5-5; convert 0/5 sonnet-5-5; verify-correction 1/10 haiku-5-5; fit-correction 2/2 sonnet-5-5; pick 1/1 opus-5-5 |
| Leap Tools | 1 | 1 | 0 | $7.345 | bundle finished; accepted/calls: requirements 4/4 sonnet-5-5; convert 1/5 sonnet-5-5; verify-correction 2/8 haiku-5-5; fit-correction 1/2 sonnet-5-5; pick 1/1 opus-5-5 |
| Freed | 1 | 1 | 0 | $6.068 | bundle finished; accepted/calls: requirements 3/3 sonnet-5-5; convert 1/5 sonnet-5-5; verify-correction 1/8 haiku-5-5; fit-correction 1/1 sonnet-5-5; pick 1/2 opus-5-5 |
| Affirm | 1 | 1 | 0 | $4.867 | bundle finished; accepted/calls: requirements 2/2 sonnet-5-5; convert 0/5 sonnet-5-5; verify-correction 2/5 haiku-5-5; fit-correction 2/3 sonnet-5-5; pick 1/1 opus-5-5 |

Recorded cost so far: $26.49.
<!-- /ai-test-run:2026-11-10T05-34-29-301Z-livebundleharness-0fee58 -->

<!-- ai-test-run:2026-11-10T05-36-30-149Z-raw-answercheckarmcomparison-536305 -->
### 2026-11-10 05:36 UTC · raw-answer check + arm comparison · requirements · sonnet:low live arm, 4 jobs (Affirm, Leap Tools, ServiceNow, Freed)

- Status: **finished: Sonnet low FAILS and saves nothing; requirements stays Sonnet high** (updated 2026-11-10 05:36:30 UTC)
- Out dir: `~/Desktop/My Apps/infinite-canvas/tmp/claude-e2e/runs/ladder-req-sonnet-low-4`

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| requirements sonnet:low | 116 | 90 | 26 | $2.594 | ID-as-text in 26 of 116 items (22%); 13/13 answers accepted (validator gap); 6 epochs over 4 jobs |
| requirements prodA (sonnet:high), same jobs | 4 |  |  | $2.306 | 0 ID-as-text; 4 epochs |
| requirements prodB (sonnet:high), same jobs | 4 |  |  | $3.017 | 0 ID-as-text; 5 epochs |

Recorded cost so far: $7.917.
- Note: Stage cost is input-dominated: Sonnet low costs the same as Sonnet high per job, so Sonnet medium cannot be cheaper either; not run (value of information).
<!-- /ai-test-run:2026-11-10T05-36-30-149Z-raw-answercheckarmcomparison-536305 -->

<!-- ai-test-run:2026-11-10T05-38-34-851Z-blindbundlejudgeOffloadreportreviewpacket2020-e7e93b -->
### 2026-11-10 05:38 UTC · blind bundle judge (Offload report, review packet 20/20) · verify-correction, fit-correction · final bundles: both corrections at haiku:medium vs production A/B, 3 jobs

- Status: **finished: slightly below production, inconclusive at n=3** (updated 2026-11-10 05:38:34 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-recovery`

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| production A | 3 |  |  | $0.000 | scores 8, 8, 8 (mean 8.0); never last |
| production B | 3 |  |  | $0.000 | scores 8, 8, 7 (mean 7.7); last once |
| corrections haiku:medium | 3 |  |  | $0.030 | scores 7, 7, 8 (mean 7.3); last twice; one letter claim its own résumé does not back (Exelixis) |

Recorded cost so far: $0.030.
- Note: This arm also ran fit-correction at Haiku medium, which failed on its own, so the gap is not attributable to verify-correction alone. Judge the verify-correction-only arms (haiku:low now; haiku:medium alone if low fails) before approving any Haiku verify-correction.
<!-- /ai-test-run:2026-11-10T05-38-34-851Z-blindbundlejudgeOffloadreportreviewpacket2020-e7e93b -->

<!-- ai-test-run:2026-11-10T05-50-21-119Z-armcomparisoncompare-armsmjs-caf4fb -->
### 2026-11-10 05:50 UTC · arm comparison (compare-arms.mjs) · convert · haiku:high vs production A/B, 3 jobs (Exelixis, Leap Tools, Freed)

- Status: **finished: Haiku high FAILS (hard-contract breaks, bundles 20% dearer)** (updated 2026-11-10 05:50:21 UTC)
- Out dir: `~/Desktop/My Apps/infinite-canvas/tmp/claude-e2e/runs/ladder-convert-haiku-high-3`

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| convert haiku:high | 15 | 0 | 12 | $0.540 | 12 of 15 replies broke hard contracts (5-7 evidenceIds per paragraph, non-employer named as employer); 3 grounding |
| bundles prodA | 3 | 3 |  | $22.27 |  |
| bundles prodB | 3 | 3 |  | $23.63 |  |
| bundles convert haiku:high | 3 | 3 |  | $27.36 | downstream verify .69 and fit .97 vs .63-6.11 and .99-3.48 |

Recorded cost so far: $73.80.
- Note: Haiku ruled out for convert. Next rung: sonnet:low (production is sonnet:medium).
<!-- /ai-test-run:2026-11-10T05-50-21-119Z-armcomparisoncompare-armsmjs-caf4fb -->

<!-- ai-test-run:2026-11-10T05-50-21-522Z-livebundleharness-97aaa7 -->
### 2026-11-10 05:50 UTC · live bundle harness · application bundles · convert=sonnet:low

- Status: **finished** (updated 2026-11-10 06:16:55 UTC)
- Out dir: `~/Desktop/My Apps/infinite-canvas/tmp/claude-e2e/runs/ladder-convert-sonnet-low-4`
- Command: `INFINITE_CANVAS_STAGE_PROFILES=convert=sonnet:low node scripts/live-bundle-harness.mjs --job tmp/claude-e2e/runs/ladder-control-a2/canvas/.local-ai/jobs/b751c4cd-d624-427c-bf96-8e24fc543ca3/input.json --job tmp/claude-e2e/runs/ladder-control-a2/canvas/.local-ai/jobs/2e98b0b7-105c-4928-abdc-374e0fe8603a/input.json --job tmp/claude-e2e/runs/ladder-control-a2/canvas/.local-ai/jobs/97d7410f-df35-42b1-bd32-14d0d46505de/input.json --job tmp/claude-e2e/runs/ladder-control-a2/canvas/.local-ai/jobs/9781acec-1ea9-4189-9972-b829e535b827/input.json --max-minutes 150 --out tmp/claude-e2e/runs/ladder-convert-sonnet-low-4`
- Jobs: 4
- Candidates: default
- Bundles finished: 4 of 4 queued

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| Exelixis | 1 | 1 | 0 | $8.166 | bundle finished; accepted/calls: requirements 9/9 sonnet-5-5; convert 0/5 sonnet-5-5; verify-correction 3/5 sonnet-5-5; fit-correction 2/2 sonnet-5-5; pick 1/1 opus-5-5 |
| Leap Tools | 1 | 1 | 0 | $7.490 | bundle finished; accepted/calls: requirements 4/4 sonnet-5-5; convert 0/5 sonnet-5-5; verify-correction 4/8 sonnet-5-5; fit-correction 1/2 sonnet-5-5; pick 1/1 opus-5-5 |
| Freed | 1 | 1 | 0 | $4.679 | bundle finished; accepted/calls: requirements 2/2 sonnet-5-5; convert 1/5 sonnet-5-5; fit-correction 3/3 sonnet-5-5; verify-correction 1/2 sonnet-5-5; pick 1/1 opus-5-5 |
| Affirm | 1 | 1 | 0 | $7.530 | bundle finished; accepted/calls: requirements 2/2 sonnet-5-5; convert 0/6 sonnet-5-5; verify-correction 1/6 sonnet-5-5; fit-correction 4/5 sonnet-5-5; pick 1/1 opus-5-5 |

Recorded cost so far: $27.87.
<!-- /ai-test-run:2026-11-10T05-50-21-522Z-livebundleharness-97aaa7 -->

<!-- ai-test-run:2026-11-10T05-59-49-839Z-armcomparisoncompare-armsmjs-6d22d5 -->
### 2026-11-10 05:59 UTC · arm comparison (compare-arms.mjs) · verify-correction · haiku:low (verify only) vs production A/B, 4 jobs (Exelixis, Leap Tools, Freed, Affirm)

- Status: **finished: Haiku low FAILS (acceptance below production, new unit-patch failures)** (updated 2026-11-10 05:59:49 UTC)
- Out dir: `~/Desktop/My Apps/infinite-canvas/tmp/claude-e2e/runs/ladder-verify-haiku-low-4`

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| verify-correction prodA | 25 | 8 |  | $6.200 | 32% accepted |
| verify-correction prodB | 26 | 7 |  | $7.530 | 27% |
| verify-correction haiku:low | 31 | 6 |  | $4.670 | 19%; rejections: 9 unit-source-grounding, 8 unit-patch, 3 target-company-binding, 3 page fit |
| bundles prodA | 4 | 4 |  | $28.57 |  |
| bundles prodB | 4 | 4 |  | $29.48 |  |
| bundles verify haiku:low | 4 | 4 |  | $26.49 | 7% cheaper |

Recorded cost so far: $102.94.
- Note: Haiku medium (44% accepted in the combined arm) stays the candidate; next: verify-correction=haiku:medium alone on the same 4 jobs, then a blind bundle judge.
<!-- /ai-test-run:2026-11-10T05-59-49-839Z-armcomparisoncompare-armsmjs-6d22d5 -->

<!-- ai-test-run:2026-11-10T05-59-50-252Z-livebundleharness-5b69d4 -->
### 2026-11-10 05:59 UTC · live bundle harness · application bundles · verify-correction=haiku:medium

- Status: **finished** (updated 2026-11-10 06:28:08 UTC)
- Out dir: `~/Desktop/My Apps/infinite-canvas/tmp/claude-e2e/runs/ladder-verify-haiku-medium-4`
- Command: `INFINITE_CANVAS_STAGE_PROFILES=verify-correction=haiku:medium node scripts/live-bundle-harness.mjs --job tmp/claude-e2e/runs/ladder-control-a2/canvas/.local-ai/jobs/b751c4cd-d624-427c-bf96-8e24fc543ca3/input.json --job tmp/claude-e2e/runs/ladder-control-a2/canvas/.local-ai/jobs/2e98b0b7-105c-4928-abdc-374e0fe8603a/input.json --job tmp/claude-e2e/runs/ladder-control-a2/canvas/.local-ai/jobs/97d7410f-df35-42b1-bd32-14d0d46505de/input.json --job tmp/claude-e2e/runs/ladder-control-a2/canvas/.local-ai/jobs/9781acec-1ea9-4189-9972-b829e535b827/input.json --max-minutes 150 --out tmp/claude-e2e/runs/ladder-verify-haiku-medium-4`
- Jobs: 4
- Candidates: default
- Bundles finished: 4 of 4 queued

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| Exelixis | 1 | 1 | 0 | $7.684 | bundle finished; accepted/calls: requirements 6/6 sonnet-5-5; convert 0/5 sonnet-5-5; verify-correction 2/7 haiku-5-5; fit-correction 3/3 sonnet-5-5; pick 1/1 opus-5-5 |
| Leap Tools | 1 | 1 | 0 | $7.925 | bundle finished; accepted/calls: requirements 8/8 sonnet-5-5; convert 0/5 sonnet-5-5; verify-correction 2/5 haiku-5-5; fit-correction 2/2 sonnet-5-5; pick 1/1 opus-5-5 |
| Freed | 1 | 1 | 0 | $6.737 | bundle finished; accepted/calls: requirements 2/2 sonnet-5-5; convert 0/5 sonnet-5-5; verify-correction 1/9 haiku-5-5; fit-correction 2/2 sonnet-5-5; pick 1/1 opus-5-5 |
| Affirm | 1 | 1 | 0 | $5.638 | bundle finished; accepted/calls: requirements 2/2 sonnet-5-5; convert 0/5 sonnet-5-5; verify-correction 2/7 haiku-5-5; fit-correction 3/4 sonnet-5-5; pick 1/1 opus-5-5 |

Recorded cost so far: $27.98.
<!-- /ai-test-run:2026-11-10T05-59-50-252Z-livebundleharness-5b69d4 -->

<!-- ai-test-run:2026-11-10T06-03-04-864Z-armcomparisoncompare-armsmjs-69ae39 -->
### 2026-11-10 06:03 UTC · arm comparison (compare-arms.mjs) · fit-correction · haiku:high (fit only) vs production A/B, 4 jobs

- Status: **finished: Haiku high FAILS (46% accepted, costs more)** (updated 2026-11-10 06:03:04 UTC)
- Out dir: `~/Desktop/My Apps/infinite-canvas/tmp/claude-e2e/runs/ladder-fit-haiku-high-4`
- Token split (24 calls each): production: 2.49M cache read, 0.40M cache write, 36K output; Haiku high: 2.23M read, 0.93M write, 87K output. The stage resumes the writer session, so cost is context, not output.

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| fit-correction prodA | 13 | 11 |  | $4.470 | 85% accepted |
| fit-correction prodB | 11 | 10 |  | $4.540 | 91% |
| fit-correction haiku:high | 24 | 11 |  | $8.000 | 46%; rejections: 6 page fit, 6 unit-patch, 1 grounding |
| bundles prodA | 4 | 4 |  | $28.57 |  |
| bundles prodB | 4 | 4 |  | $29.48 |  |
| bundles fit haiku:high | 4 | 4 |  | $32.47 |  |

Recorded cost so far: $107.53.
- Note: Haiku ruled out for fit-correction. A lower Sonnet effort can only trim output (~10-20%, about $75-150 a year). Next: one step down, fit-correction=sonnet:medium; stop if it fails.
<!-- /ai-test-run:2026-11-10T06-03-04-864Z-armcomparisoncompare-armsmjs-69ae39 -->

<!-- ai-test-run:2026-11-10T06-03-05-231Z-livebundleharness-f92448 -->
### 2026-11-10 06:03 UTC · live bundle harness · application bundles · fit-correction=sonnet:medium

- Status: **finished** (updated 2026-11-10 06:30:53 UTC)
- Out dir: `~/Desktop/My Apps/infinite-canvas/tmp/claude-e2e/runs/ladder-fit-sonnet-medium-4`
- Command: `INFINITE_CANVAS_STAGE_PROFILES=fit-correction=sonnet:medium node scripts/live-bundle-harness.mjs --job tmp/claude-e2e/runs/ladder-control-a2/canvas/.local-ai/jobs/b751c4cd-d624-427c-bf96-8e24fc543ca3/input.json --job tmp/claude-e2e/runs/ladder-control-a2/canvas/.local-ai/jobs/2e98b0b7-105c-4928-abdc-374e0fe8603a/input.json --job tmp/claude-e2e/runs/ladder-control-a2/canvas/.local-ai/jobs/97d7410f-df35-42b1-bd32-14d0d46505de/input.json --job tmp/claude-e2e/runs/ladder-control-a2/canvas/.local-ai/jobs/9781acec-1ea9-4189-9972-b829e535b827/input.json --max-minutes 150 --out tmp/claude-e2e/runs/ladder-fit-sonnet-medium-4`
- Jobs: 4
- Candidates: default
- Bundles finished: 4 of 4 queued

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| Exelixis | 1 | 1 | 0 | $9.408 | bundle finished; accepted/calls: requirements 9/9 sonnet-5-5; convert 0/6 sonnet-5-5; verify-correction 2/7 sonnet-5-5; fit-correction 3/3 sonnet-5-5; pick 1/1 opus-5-5 |
| Leap Tools | 1 | 1 | 0 | $10.23 | bundle finished; accepted/calls: requirements 4/4 sonnet-5-5; convert 0/5 sonnet-5-5; verify-correction 1/9 sonnet-5-5; fit-correction 4/6 sonnet-5-5; pick 1/1 opus-5-5 |
| Freed | 1 | 1 | 0 | $6.246 | bundle finished; accepted/calls: requirements 2/2 sonnet-5-5; convert 0/5 sonnet-5-5; verify-correction 3/6 sonnet-5-5; fit-correction 2/2 sonnet-5-5; pick 1/1 opus-5-5 |
| Affirm | 1 | 1 | 0 | $8.738 | bundle finished; accepted/calls: requirements 2/2 sonnet-5-5; convert 0/7 sonnet-5-5; verify-correction 1/7 sonnet-5-5; fit-correction 4/5 sonnet-5-5; pick 1/1 opus-5-5 |

Recorded cost so far: $34.62.
<!-- /ai-test-run:2026-11-10T06-03-05-231Z-livebundleharness-f92448 -->

<!-- ai-test-run:2026-11-10T06-23-45-652Z-armcomparisoncompare-armsmjs-378d92 -->
### 2026-11-10 06:23 UTC · arm comparison (compare-arms.mjs) · convert · sonnet:low vs production A/B (sonnet:medium), 4 jobs

- Status: **finished: Sonnet low saves nothing; convert stays Sonnet medium** (updated 2026-11-10 06:23:45 UTC)
- Out dir: `~/Desktop/My Apps/infinite-canvas/tmp/claude-e2e/runs/ladder-convert-sonnet-low-4`

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| convert prodA | 20 | 1 |  | $2.440 |  |
| convert prodB | 21 | 3 |  | $2.920 |  |
| convert sonnet:low | 21 | 1 | 0 | $2.550 | 0 hard-contract breaks (Haiku: 12-14 of 15-24) |
| bundles prodA | 4 | 4 |  | $28.57 |  |
| bundles prodB | 4 | 4 |  | $29.48 |  |
| bundles convert sonnet:low | 4 | 4 |  | $27.87 | within the production pair |

Recorded cost so far: $93.83.
- Note: Sonnet low behaves like production but costs the same per call ($0.12), so no setting below Sonnet medium saves money: convert stays Sonnet medium.
<!-- /ai-test-run:2026-11-10T06-23-45-652Z-armcomparisoncompare-armsmjs-378d92 -->

<!-- ai-test-run:2026-11-10T06-28-52-768Z-armcomparisoncompare-armsmjs-65dc7d -->
### 2026-11-10 06:28 UTC · arm comparison (compare-arms.mjs) · verify-correction · haiku:medium (verify only) vs production A/B, 4 jobs

- Status: **finished: passes acceptance and cost; blind bundle judge pending** (updated 2026-11-10 06:28:52 UTC)
- Out dir: `~/Desktop/My Apps/infinite-canvas/tmp/claude-e2e/runs/ladder-verify-haiku-medium-4`

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| verify-correction prodA | 25 | 8 |  | $6.200 | 32% |
| verify-correction prodB | 26 | 7 |  | $7.530 | 27% |
| verify-correction haiku:medium | 28 | 7 |  | $4.320 | 25%, within the production pair; rejections: 8 unit-patch, 7 page fit, 3 grounding, 2 claim scope |
| bundles prodA | 4 | 4 |  | $28.57 |  |
| bundles prodB | 4 | 4 |  | $29.48 |  |
| bundles verify haiku:medium | 4 | 4 |  | $27.98 |  |

Recorded cost so far: $104.08.
- Note: verify-correction is about $1,600 a year; a 30-43% cut is worth about $500 a year if quality holds. Blind bundle judge: Offload report job oj-20261110-390dbfff48da4b689ba0eeff850636fa, key bundle-judge-verify-key.json.
<!-- /ai-test-run:2026-11-10T06-28-52-768Z-armcomparisoncompare-armsmjs-65dc7d -->

<!-- ai-test-run:2026-11-10T06-31-10-226Z-armcomparisoncompare-armsmjs-e4f25a -->
### 2026-11-10 06:31 UTC · arm comparison (compare-arms.mjs) · fit-correction · sonnet:medium (fit only) vs production A/B (sonnet:high), 4 jobs

- Status: **finished: Sonnet medium costs more; fit-correction stays Sonnet high** (updated 2026-11-10 06:31:10 UTC)
- Out dir: `~/Desktop/My Apps/infinite-canvas/tmp/claude-e2e/runs/ladder-fit-sonnet-medium-4`

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| fit-correction prodA | 13 | 11 |  | $4.470 | 85% |
| fit-correction prodB | 11 | 10 |  | $4.540 | 91% |
| fit-correction sonnet:medium | 16 | 13 |  | $6.690 | 81%; $0.42 a call vs $0.34 |
| bundles prodA | 4 | 4 |  | $28.57 |  |
| bundles prodB | 4 | 4 |  | $29.48 |  |
| bundles fit sonnet:medium | 4 | 4 |  | $34.62 |  |

Recorded cost so far: $108.37.
- Note: One step down from production costs more, so stepping stops: fit-correction stays Sonnet high (Haiku medium and high failed earlier).
<!-- /ai-test-run:2026-11-10T06-31-10-226Z-armcomparisoncompare-armsmjs-e4f25a -->

<!-- ai-test-run:2026-11-10T06-32-51-062Z-blindbundlejudgeOffloadreportreviewpacket2626-a5966a -->
### 2026-11-10 06:32 UTC · blind bundle judge (Offload report, review packet 26/26) · verify-correction · final bundles: verify-correction haiku:medium alone vs production A/B, 4 jobs

- Status: **finished: within noise of production; confirming on 4 more jobs** (updated 2026-11-10 06:32:51 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-recovery`

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| production A | 4 |  |  | $0.000 | scores 7, 8, 8, 7 (mean 7.5) |
| production B | 4 |  |  | $0.000 | scores 8, 7, 7, 7 (mean 7.25) |
| verify-correction haiku:medium | 4 |  |  | $0.020 | scores 7, 8, 7, 8 (mean 7.5); best on Affirm |

Recorded cost so far: $0.020.
- Note: Next: expand to the other 4 jobs both production runs finished (Decoda Health, Faire, Remitly, Stripe), then judge again before applying.
<!-- /ai-test-run:2026-11-10T06-32-51-062Z-blindbundlejudgeOffloadreportreviewpacket2626-a5966a -->

<!-- ai-test-run:2026-11-10T06-32-57-234Z-livebundleharness-b48522 -->
### 2026-11-10 06:32 UTC · live bundle harness · application bundles · verify-correction=haiku:medium

- Status: **finished** (updated 2026-11-10 06:54:22 UTC)
- Out dir: `~/Desktop/My Apps/infinite-canvas/tmp/claude-e2e/runs/ladder-verify-haiku-medium-confirm-4`
- Command: `INFINITE_CANVAS_STAGE_PROFILES=verify-correction=haiku:medium node scripts/live-bundle-harness.mjs --job tmp/claude-e2e/runs/ladder-control-a2/canvas/.local-ai/jobs/416f322b-a97e-4853-b374-a90bd92cec87/input.json --job tmp/claude-e2e/runs/ladder-control-a2/canvas/.local-ai/jobs/abc74539-766a-4dd8-871f-37ff084860a2/input.json --job tmp/claude-e2e/runs/ladder-control-a2/canvas/.local-ai/jobs/ccd36492-d78c-42f8-b87f-ecc5ad86579f/input.json --job tmp/claude-e2e/runs/ladder-control-a2/canvas/.local-ai/jobs/50bc3110-59c1-4ce7-a87c-3a6e473d62f4/input.json --max-minutes 150 --out tmp/claude-e2e/runs/ladder-verify-haiku-medium-confirm-4`
- Jobs: 4
- Candidates: default
- Bundles finished: 3 of 3 queued

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| Decoda Health | 1 | 1 | 0 | $5.651 | bundle finished; accepted/calls: requirements 3/3 sonnet-5-5; convert 0/5 sonnet-5-5; verify-correction 4/8 haiku-5-5; fit-correction 1/1 sonnet-5-5; pick 1/1 opus-5-5 |
| Remitly | 1 | 1 | 0 | $4.263 | bundle finished; accepted/calls: requirements 1/1 sonnet-5-5; convert 0/5 sonnet-5-5; verify-correction 5/8 haiku-5-5; pick 1/1 opus-5-5 |
| Stripe | 1 | 1 | 0 | $4.956 | bundle finished; accepted/calls: requirements 2/2 sonnet-5-5; convert 1/5 sonnet-5-5; verify-correction 2/9 haiku-5-5; pick 1/1 opus-5-5 |

Recorded cost so far: $14.87.
<!-- /ai-test-run:2026-11-10T06-32-57-234Z-livebundleharness-b48522 -->

<!-- ai-test-run:2026-11-10T07-01-33-969Z-blindbundlejudgeOffloadreportreviewpacket2323-219344 -->
### 2026-11-10 07:01 UTC · blind bundle judge (Offload report, review packet 23/23) · verify-correction · confirmation: verify-correction haiku:medium alone vs production A/B, 3 more jobs (Decoda Health, Remitly, Stripe)

- Status: **finished: PASSES; verify-correction moves to Haiku medium** (updated 2026-11-10 07:01:33 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-recovery`
- Acceptance (3 jobs): Haiku medium 11/25 (44%) vs production 12/25 (48%) and 11/28 (39%) on the same jobs plus Faire

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| production A | 3 |  |  | $0.000 | scores 8, 6, 8; 7-job mean 7.43 |
| production B | 3 |  |  | $0.000 | scores 8, 7, 7; 7-job mean 7.29 |
| verify-correction haiku:medium | 3 |  |  | $0.020 | scores 7, 8, 8; 7-job mean 7.57 |

Recorded cost so far: $0.020.
- Note: Faire skipped a third time (employer source verification incomplete): a posting problem, not the model. One unsupported claim was flagged in each arm, so it is not a Haiku pattern.
<!-- /ai-test-run:2026-11-10T07-01-33-969Z-blindbundlejudgeOffloadreportreviewpacket2323-219344 -->

<!-- ai-test-run:2026-11-10T07-44-18-991Z-claude-effort-ladderrun-c824c0 -->
### 2026-11-10 07:44 UTC · claude-effort-ladder run · requirements-adjudication · haiku:low, haiku:medium, haiku:high, sonnet:low, sonnet:medium, sonnet:high

- Status: **finished** (updated 2026-11-10 07:45:42 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-requirements-adjudication/run`
- Command: `node scripts/claude-effort-ladder.mjs run --records ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-requirements-adjudication/records.jsonl --configs haiku:low,haiku:medium,haiku:high,sonnet:low,sonnet:medium,sonnet:high --reps 1 --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-requirements-adjudication/run --concurrency 4`
- Records: 12 from ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-requirements-adjudication/records.jsonl
- Reps: 1

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| requirements-adjudication haiku:high | 12 | 12 | 0 | $0.015 |  |
| requirements-adjudication haiku:low | 12 | 12 | 0 | $0.013 |  |
| requirements-adjudication haiku:medium | 12 | 12 | 0 | $0.013 |  |
| requirements-adjudication sonnet:high | 12 | 12 | 0 | $0.140 |  |
| requirements-adjudication sonnet:low | 12 | 12 | 0 | $0.135 |  |
| requirements-adjudication sonnet:medium | 12 | 12 | 0 | $0.136 |  |

Recorded cost so far: $0.453.
<!-- /ai-test-run:2026-11-10T07-44-18-991Z-claude-effort-ladderrun-c824c0 -->

<!-- ai-test-run:2026-11-10T07-46-12-858Z-claude-effort-ladderrun-950afb -->
### 2026-11-10 07:46 UTC · claude-effort-ladder run · requirements-adjudication · haiku:low, sonnet:high

- Status: **finished** (updated 2026-11-10 07:47:50 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-requirements-adjudication/run-wide`
- Command: `node scripts/claude-effort-ladder.mjs run --records ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-requirements-adjudication/records-wide.jsonl --configs haiku:low,sonnet:high --reps 1 --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-requirements-adjudication/run-wide --concurrency 6`
- Records: 54 from ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-requirements-adjudication/records-wide.jsonl
- Reps: 1

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| requirements-adjudication haiku:low | 54 | 54 | 0 | $0.060 |  |
| requirements-adjudication sonnet:high | 54 | 54 | 0 | $0.655 |  |

Recorded cost so far: $0.716.
<!-- /ai-test-run:2026-11-10T07-46-12-858Z-claude-effort-ladderrun-950afb -->

<!-- ai-test-run:2026-11-10T07-48-25-015Z-claude-effort-ladderrun-c22590 -->
### 2026-11-10 07:48 UTC · claude-effort-ladder run · requirements-adjudication · haiku:medium, haiku:high, sonnet:low, sonnet:medium

- Status: **finished** (updated 2026-11-10 07:51:37 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-requirements-adjudication/run-wide`
- Command: `node scripts/claude-effort-ladder.mjs run --records ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-requirements-adjudication/records-wide.jsonl --configs haiku:medium,haiku:high,sonnet:low,sonnet:medium --reps 1 --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-requirements-adjudication/run-wide --concurrency 6`
- Records: 54 from ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-requirements-adjudication/records-wide.jsonl
- Reps: 1

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| requirements-adjudication haiku:high | 54 | 54 | 0 | $0.067 |  |
| requirements-adjudication haiku:low | 54 | 54 | 0 | $0.060 |  |
| requirements-adjudication haiku:medium | 54 | 54 | 0 | $0.062 |  |
| requirements-adjudication sonnet:high | 54 | 54 | 0 | $0.655 |  |
| requirements-adjudication sonnet:low | 54 | 54 | 0 | $0.609 |  |
| requirements-adjudication sonnet:medium | 54 | 54 | 0 | $0.632 |  |

Recorded cost so far: $2.085.
<!-- /ai-test-run:2026-11-10T07-48-25-015Z-claude-effort-ladderrun-c22590 -->

<!-- ai-test-run:2026-11-10T07-51-57-894Z-ladderagreementagreementmjs-3010d6 -->
### 2026-11-10 07:51 UTC · ladder agreement (agreement.mjs) · requirements-adjudication · every setting vs production (sonnet:high), 54 prompts / 69 decisions

- Status: **finished: Sonnet low is the cheapest passing setting** (updated 2026-11-10 07:51:57 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-requirements-adjudication`

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| haiku:low | 69 | 47 |  | $0.060 | 68.1% agreement: fail |
| haiku:medium | 69 | 47 |  | $0.062 | 68.1%: fail |
| haiku:high | 69 | 53 |  | $0.067 | 76.8%: fail |
| sonnet:low | 69 | 63 |  | $0.609 | 91.3% = production rerun; 7% cheaper |
| sonnet:medium | 69 | 61 |  | $0.632 | 88.4% |
| sonnet:high (production rerun) | 69 | 63 |  | $0.655 | 91.3% noise floor |

Recorded cost so far: $2.085.
- Note: Prompts captured from this round's live arms (production answers). Apply sonnet:low as an explicit profile; the stage has none today and runs on the Sonnet high default.
<!-- /ai-test-run:2026-11-10T07-51-57-894Z-ladderagreementagreementmjs-3010d6 -->

<!-- ai-test-run:2026-11-10T08-15-41-733Z-claude-effort-ladderrun-8bd6f2 -->
### 2026-11-10 08:15 UTC · claude-effort-ladder run · career-profile-audit-metrics, career-profile-audit-grounding, career-profile-audit-attribution, career-profile-audit-conflicts, career-profile-audit-completeness · haiku:low, haiku:medium, haiku:high, sonnet:medium

- Status: **finished** (updated 2026-11-10 08:21:02 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-career-audits-planted/run`
- Command: `node scripts/claude-effort-ladder.mjs run --records ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-career-audits-planted/records.jsonl --configs haiku:low,haiku:medium,haiku:high,sonnet:medium --reps 2 --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-career-audits-planted/run --concurrency 6`
- Records: 10 from ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-career-audits-planted/records.jsonl
- Reps: 2

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| career-profile-audit-attribution haiku:high | 4 | 4 | 0 | $0.035 |  |
| career-profile-audit-attribution haiku:low | 4 | 4 | 0 | $0.028 |  |
| career-profile-audit-attribution haiku:medium | 4 | 4 | 0 | $0.031 |  |
| career-profile-audit-attribution sonnet:medium | 4 | 4 | 0 | $0.297 |  |
| career-profile-audit-completeness haiku:high | 4 | 4 | 0 | $0.048 |  |
| career-profile-audit-completeness haiku:low | 4 | 4 | 0 | $0.032 |  |
| career-profile-audit-completeness haiku:medium | 4 | 4 | 0 | $0.036 |  |
| career-profile-audit-completeness sonnet:medium | 4 | 4 | 0 | $0.338 |  |
| career-profile-audit-conflicts haiku:high | 4 | 4 | 0 | $0.032 |  |
| career-profile-audit-conflicts haiku:low | 4 | 4 | 0 | $0.026 |  |
| career-profile-audit-conflicts haiku:medium | 4 | 4 | 0 | $0.029 |  |
| career-profile-audit-conflicts sonnet:medium | 4 | 4 | 0 | $0.288 |  |
| career-profile-audit-grounding haiku:high | 4 | 4 | 0 | $0.037 |  |
| career-profile-audit-grounding haiku:low | 4 | 4 | 0 | $0.028 |  |
| career-profile-audit-grounding haiku:medium | 4 | 4 | 0 | $0.030 |  |
| career-profile-audit-grounding sonnet:medium | 4 | 4 | 0 | $0.289 |  |
| career-profile-audit-metrics haiku:high | 4 | 4 | 0 | $0.040 |  |
| career-profile-audit-metrics haiku:low | 4 | 4 | 0 | $0.032 |  |
| career-profile-audit-metrics haiku:medium | 4 | 4 | 0 | $0.033 |  |
| career-profile-audit-metrics sonnet:medium | 4 | 4 | 0 | $0.313 |  |

Recorded cost so far: $2.024.
<!-- /ai-test-run:2026-11-10T08-15-41-733Z-claude-effort-ladderrun-8bd6f2 -->

<!-- ai-test-run:2026-11-10T08-21-17-953Z-claude-effort-ladderrun-340d81 -->
### 2026-11-10 08:21 UTC · claude-effort-ladder run · career-profile-audit-metrics, career-profile-audit-attribution, career-profile-audit-completeness, career-profile-audit-grounding, career-profile-audit-conflicts · haiku:low, haiku:medium

- Status: **finished** (updated 2026-11-10 08:23:02 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-career-audits-planted/clean-run`
- Command: `node scripts/claude-effort-ladder.mjs run --records ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-career-audits-planted/clean-records.jsonl --configs haiku:low,haiku:medium --reps 1 --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-career-audits-planted/clean-run --concurrency 6`
- Records: 30 from ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-career-audits-planted/clean-records.jsonl
- Reps: 1

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| career-profile-audit-attribution haiku:low | 6 | 6 | 0 | $0.024 |  |
| career-profile-audit-attribution haiku:medium | 6 | 6 | 0 | $0.025 |  |
| career-profile-audit-completeness haiku:low | 6 | 6 | 0 | $0.027 |  |
| career-profile-audit-completeness haiku:medium | 6 | 6 | 0 | $0.030 |  |
| career-profile-audit-conflicts haiku:low | 6 | 6 | 0 | $0.023 |  |
| career-profile-audit-conflicts haiku:medium | 6 | 6 | 0 | $0.025 |  |
| career-profile-audit-grounding haiku:low | 6 | 6 | 0 | $0.025 |  |
| career-profile-audit-grounding haiku:medium | 6 | 6 | 0 | $0.030 |  |
| career-profile-audit-metrics haiku:low | 6 | 6 | 0 | $0.022 |  |
| career-profile-audit-metrics haiku:medium | 6 | 6 | 0 | $0.022 |  |

Recorded cost so far: $0.253.
<!-- /ai-test-run:2026-11-10T08-21-17-953Z-claude-effort-ladderrun-340d81 -->

<!-- ai-test-run:2026-11-10T08-23-23-820Z-claude-effort-laddercapture-career-f5f8ba -->
### 2026-11-10 08:23 UTC · claude-effort-ladder capture-career · career-profile-repair · haiku:low,haiku:medium,haiku:high

- Status: **failed: Career profile page-0003 is invalid: edit 0 (set achievements/p0003-ach-flitex-a-star-routing/technologies): edit to achievements/p0003-ach-flitex-a-star-routing/technologies proposes no change | edit 1 (set achievements/p0003-ach-flitex-faa-cron-sync/technologies): edit to achievements/p0003-ach-flitex-faa-cron-sync/technologies proposes no change | edit 2 (set projects/p0003-project-marketplace-hub/technologies): edit to projects/p0003-project-marketplace-hub/technologies proposes no change** (updated 2026-11-10 08:33:23 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-career-audits-haiku-low-converge`
- Command: `node scripts/claude-effort-ladder.mjs capture-career --source ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-09-career-capture/src/career data.md --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-career-audits-haiku-low-converge --ladder-tasks career-profile-repair --configs haiku:low,haiku:medium,haiku:high --reps 1 --concurrency 4 --max-calls 0 --baseline-from ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-09-career-capture/base2 --live-on-miss --profile-override career-profile-audit-metrics=haiku:low --profile-override career-profile-audit-grounding=haiku:low --profile-override career-profile-audit-attribution=haiku:low --profile-override career-profile-audit-conflicts=haiku:low --profile-override career-profile-audit-completeness=haiku:low`

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| production baseline | 63 | 46 |  | $0.346 | 2 repairs |
| ladder cells | 18 | 17 | 0 | $0.146 | per-config rows: summarize --out |

Recorded cost so far: $0.492.
<!-- /ai-test-run:2026-11-10T08-23-23-820Z-claude-effort-laddercapture-career-f5f8ba -->

<!-- ai-test-run:2026-11-10T08-24-11-878Z-claude-effort-ladderrun-ff49b9 -->
### 2026-11-10 08:24 UTC · claude-effort-ladder run · qa-brief, qa-write · haiku:medium, sonnet:medium, opus:low, opus:medium

- Status: **finished** (updated 2026-11-10 08:42:13 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-interview-prepare-saved/run`
- Command: `node scripts/claude-effort-ladder.mjs run --records ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-interview-prepare-saved/records-ladder.jsonl --configs haiku:medium,sonnet:medium,opus:low,opus:medium --reps 1 --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-interview-prepare-saved/run --concurrency 4`
- Records: 6 from ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-interview-prepare-saved/records-ladder.jsonl
- Reps: 1

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| qa-brief haiku:medium | 4 | 4 | 0 | $0.037 |  |
| qa-brief opus:low | 4 | 4 | 0 | $0.466 |  |
| qa-brief opus:medium | 4 | 4 | 0 | $0.761 |  |
| qa-brief sonnet:medium | 4 | 4 | 0 | $0.254 |  |
| qa-write haiku:medium | 2 | 2 | 0 | $0.240 |  |
| qa-write opus:low | 2 | 2 | 0 | $1.439 |  |
| qa-write opus:medium | 2 | 2 | 0 | $2.477 |  |
| qa-write sonnet:medium | 2 | 2 | 0 | $1.254 |  |

Recorded cost so far: $6.929.
<!-- /ai-test-run:2026-11-10T08-24-11-878Z-claude-effort-ladderrun-ff49b9 -->

<!-- ai-test-run:2026-11-10T08-25-02-393Z-claude-effort-ladderrun-8a8a1c -->
### 2026-11-10 08:25 UTC · claude-effort-ladder run · job-listing-liveness · haiku:low, haiku:medium, sonnet:medium

- Status: **finished** (updated 2026-11-10 08:25:34 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-liveness/run`
- Command: `node scripts/claude-effort-ladder.mjs run --records ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-liveness/records.jsonl --configs haiku:low,haiku:medium,sonnet:medium --reps 2 --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-liveness/run --concurrency 6`
- Records: 6 from ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-liveness/records.jsonl
- Reps: 2

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| job-listing-liveness haiku:low | 12 | 12 | 0 | $0.031 |  |
| job-listing-liveness haiku:medium | 12 | 12 | 0 | $0.032 |  |
| job-listing-liveness sonnet:medium | 12 | 12 | 0 | $0.312 |  |

Recorded cost so far: $0.375.
<!-- /ai-test-run:2026-11-10T08-25-02-393Z-claude-effort-ladderrun-8a8a1c -->

<!-- ai-test-run:2026-11-10T08-25-42-498Z-ladderagreement-5b0332 -->
### 2026-11-10 08:25 UTC · ladder agreement · job-listing-liveness · haiku:low (production) vs haiku:medium and sonnet:medium, 6 recorded real pages x2

- Status: **partial: all 6 recorded pages were open listings, so closed/moved cases are untested** (updated 2026-11-10 08:25:42 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-liveness`

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| haiku:low (production) | 12 | 11 |  | $0.031 | verdict matches production 11/12 |
| haiku:medium | 12 | 10 |  | $0.032 | 10/12 |
| sonnet:medium | 12 | 12 |  | $0.312 | 12/12 |

Recorded cost so far: $0.375.
- Note: Needs closed/moved listings, which only a real Job Board run records.
<!-- /ai-test-run:2026-11-10T08-25-42-498Z-ladderagreement-5b0332 -->

<!-- ai-test-run:2026-11-10T08-33-36-261Z-claude-effort-laddercapture-career-95f53d -->
### 2026-11-10 08:33 UTC · claude-effort-ladder capture-career · career-profile-audit-metrics · haiku:low

- Status: **finished** (updated 2026-11-10 08:36:21 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-career-audit-metrics-haiku-low-converge`
- Command: `node scripts/claude-effort-ladder.mjs capture-career --source ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-09-career-capture/src/career data.md --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-career-audit-metrics-haiku-low-converge --ladder-tasks career-profile-audit-metrics --configs haiku:low --reps 1 --concurrency 3 --max-calls 0 --baseline-from ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-09-career-capture/base2 --live-on-miss --profile-override career-profile-audit-metrics=haiku:low`

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| production baseline | 63 | 14 |  | $0.093 | 1 repairs |
| ladder cells | 9 | 9 | 0 | $0.034 | per-config rows: summarize --out |

Recorded cost so far: $0.126.
<!-- /ai-test-run:2026-11-10T08-33-36-261Z-claude-effort-laddercapture-career-95f53d -->

<!-- ai-test-run:2026-11-10T08-33-36-273Z-claude-effort-laddercapture-career-ca8e83 -->
### 2026-11-10 08:33 UTC · claude-effort-ladder capture-career · career-profile-audit-grounding · haiku:low

- Status: **finished** (updated 2026-11-10 08:45:10 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-career-audit-grounding-haiku-low-converge`
- Command: `node scripts/claude-effort-ladder.mjs capture-career --source ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-09-career-capture/src/career data.md --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-career-audit-grounding-haiku-low-converge --ladder-tasks career-profile-audit-grounding --configs haiku:low --reps 1 --concurrency 3 --max-calls 0 --baseline-from ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-09-career-capture/base2 --live-on-miss --profile-override career-profile-audit-grounding=haiku:low`

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| production baseline | 119 | 50 |  | $0.480 | 1 repairs |
| ladder cells | 18 | 18 | 0 | $0.087 | per-config rows: summarize --out |

Recorded cost so far: $0.567.
<!-- /ai-test-run:2026-11-10T08-33-36-273Z-claude-effort-laddercapture-career-ca8e83 -->

<!-- ai-test-run:2026-11-10T08-33-36-293Z-claude-effort-laddercapture-career-6a7df5 -->
### 2026-11-10 08:33 UTC · claude-effort-ladder capture-career · career-profile-audit-completeness · haiku:low

- Status: **finished** (updated 2026-11-10 08:47:51 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-career-audit-completeness-haiku-low-converge`
- Command: `node scripts/claude-effort-ladder.mjs capture-career --source ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-09-career-capture/src/career data.md --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-career-audit-completeness-haiku-low-converge --ladder-tasks career-profile-audit-completeness --configs haiku:low --reps 1 --concurrency 3 --max-calls 0 --baseline-from ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-09-career-capture/base2 --live-on-miss --profile-override career-profile-audit-completeness=haiku:low`

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| production baseline | 122 | 69 |  | $0.805 | 2 repairs |
| ladder cells | 18 | 18 | 0 | $0.090 | per-config rows: summarize --out |

Recorded cost so far: $0.895.
<!-- /ai-test-run:2026-11-10T08-33-36-293Z-claude-effort-laddercapture-career-6a7df5 -->

<!-- ai-test-run:2026-11-10T08-33-36-277Z-claude-effort-laddercapture-career-63a763 -->
### 2026-11-10 08:33 UTC · claude-effort-ladder capture-career · career-profile-audit-conflicts · haiku:low

- Status: **finished** (updated 2026-11-10 08:38:56 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-career-audit-conflicts-haiku-low-converge`
- Command: `node scripts/claude-effort-ladder.mjs capture-career --source ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-09-career-capture/src/career data.md --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-career-audit-conflicts-haiku-low-converge --ladder-tasks career-profile-audit-conflicts --configs haiku:low --reps 1 --concurrency 3 --max-calls 0 --baseline-from ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-09-career-capture/base2 --live-on-miss --profile-override career-profile-audit-conflicts=haiku:low`

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| production baseline | 101 | 32 |  | $0.267 | 0 repairs |
| ladder cells | 15 | 15 | 0 | $0.064 | per-config rows: summarize --out |

Recorded cost so far: $0.330.
<!-- /ai-test-run:2026-11-10T08-33-36-277Z-claude-effort-laddercapture-career-63a763 -->

<!-- ai-test-run:2026-11-10T08-33-36-303Z-claude-effort-laddercapture-career-c1ef9e -->
### 2026-11-10 08:33 UTC · claude-effort-ladder capture-career · career-profile-audit-attribution · haiku:low

- Status: **finished** (updated 2026-11-10 08:44:20 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-career-audit-attribution-haiku-low-converge`
- Command: `node scripts/claude-effort-ladder.mjs capture-career --source ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-09-career-capture/src/career data.md --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-career-audit-attribution-haiku-low-converge --ladder-tasks career-profile-audit-attribution --configs haiku:low --reps 1 --concurrency 3 --max-calls 0 --baseline-from ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-09-career-capture/base2 --live-on-miss --profile-override career-profile-audit-attribution=haiku:low`

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| production baseline | 139 | 50 |  | $0.601 | 1 repairs |
| ladder cells | 21 | 21 | 0 | $0.094 | per-config rows: summarize --out |

Recorded cost so far: $0.694.
<!-- /ai-test-run:2026-11-10T08-33-36-303Z-claude-effort-laddercapture-career-c1ef9e -->

<!-- ai-test-run:2026-11-10T08-33-49-849Z-claude-effort-laddercapture-career-67cc73 -->
### 2026-11-10 08:33 UTC · claude-effort-ladder capture-career · career-profile-repair · haiku:medium

- Status: **failed: Career snapshot convergence failed at round 4: the state repeats round 2 (profile 491e742105b59fa6942649ddb7cb40e2362feeac9803d44a08c54c00465f4841, settled decisions 95b7f7947aa20904857c15fb86b46ae763237c4f7c7b62c30b933837b7274c0d); a repair undid an earlier one.** (updated 2026-11-10 08:36:38 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-career-repair-haiku-low-converge`
- Command: `node scripts/claude-effort-ladder.mjs capture-career --source ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-09-career-capture/src/career data.md --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-career-repair-haiku-low-converge --ladder-tasks career-profile-repair --configs haiku:medium --reps 1 --concurrency 3 --max-calls 0 --baseline-from ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-09-career-capture/base2 --live-on-miss --profile-override career-profile-repair=haiku:low`

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| production baseline | 9 | 6 |  | $0.024 | 0 repairs |
| ladder cells | 6 | 6 | 0 | $0.026 | per-config rows: summarize --out |

Recorded cost so far: $0.050.
<!-- /ai-test-run:2026-11-10T08-33-49-849Z-claude-effort-laddercapture-career-67cc73 -->

<!-- ai-test-run:2026-11-10T08-36-47-960Z-claude-effort-laddercapture-career-94bb8f -->
### 2026-11-10 08:36 UTC · claude-effort-ladder capture-career · career-profile-repair · haiku:high

- Status: **failed: Career snapshot convergence failed at round 4: the state repeats round 2 (profile 61446bfd0465c08ec8cc9ec00991d297c2aaf1d04c5780e430a39414803c56cf, settled decisions 22d6c4d9e824ccc0e7d75014a9da173bfe3a5ef02541f807dbb2ae8ce3cbd27c); a repair undid an earlier one.** (updated 2026-11-10 08:42:18 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-career-repair-haiku-medium-converge`
- Command: `node scripts/claude-effort-ladder.mjs capture-career --source ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-09-career-capture/src/career data.md --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-career-repair-haiku-medium-converge --ladder-tasks career-profile-repair --configs haiku:high --reps 1 --concurrency 3 --max-calls 0 --baseline-from ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-09-career-capture/base2 --live-on-miss --profile-override career-profile-repair=haiku:medium`

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| production baseline | 10 | 7 |  | $0.037 | 0 repairs |
| ladder cells | 7 | 7 | 0 | $0.043 | per-config rows: summarize --out |

Recorded cost so far: $0.080.
<!-- /ai-test-run:2026-11-10T08-36-47-960Z-claude-effort-laddercapture-career-94bb8f -->

<!-- ai-test-run:2026-11-10T08-42-41-974Z-claude-effort-laddercapture-career-dcbe96 -->
### 2026-11-10 08:42 UTC · claude-effort-ladder capture-career · career-profile-repair · haiku:low

- Status: **failed: Career profile page-0003 is invalid: projects[p0003-project-marketplace-hub].technologyReferences[1].technology does not identify one of projects[p0003-project-marketplace-hub].technologies. | projects[p0003-project-marketplace-hub].technologyReferences[2].technology does not identify one of projects[p0003-project-marketplace-hub].technologies. | projects[p0003-project-marketplace-hub].technologyReferences[3].technology does not identify one of projects[p0003-project-marketplace-hub].technologies. | projects[p0003-project-infinite-canvas].technologyReferences[1].technology does not identify one of projects[p0003-project-infinite-canvas].technologies. | projects[p0003-project-infinite-canvas].technologyReferences[2].technology does not identify one of projects[p0003-project-infinite-canvas].technologies. | projects[p0003-project-infinite-canvas].technologyReferences[3].technology does not identify one of projects[p0003-project-infinite-canvas].technologies. | projects[p0003-project-infinite-canvas].technologyReferences[4].technology does not identify one of projects[p0003-project-infinite-canvas].technologies. | projects[p0003-project-infinite-canvas].technologyReferences[5].technology does not identify one of projects[p0003-project-infinite-canvas].technologies.** (updated 2026-11-10 09:25:36 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-career-repair-haiku-high-converge`
- Command: `node scripts/claude-effort-ladder.mjs capture-career --source ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-09-career-capture/src/career data.md --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-career-repair-haiku-high-converge --ladder-tasks career-profile-repair --configs haiku:low --reps 1 --concurrency 3 --max-calls 0 --baseline-from ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-09-career-capture/base2 --live-on-miss --profile-override career-profile-repair=haiku:high`

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| production baseline | 159 | 155 |  | $1.071 | 6 repairs |
| ladder cells | 12 | 10 | 0 | $0.072 | per-config rows: summarize --out |

Recorded cost so far: $1.142.
<!-- /ai-test-run:2026-11-10T08-42-41-974Z-claude-effort-laddercapture-career-dcbe96 -->

<!-- ai-test-run:2026-11-10T08-42-41-976Z-claude-effort-laddercapture-career-dcd6b2 -->
### 2026-11-10 08:42 UTC · claude-effort-ladder capture-career · career-profile-repair · haiku:low

- Status: **failed: Career profile page-0003 is invalid: edit 6 (set-coverage segmentCoverage/segment-0089/*): edit to segmentCoverage/segment-0089/disposition proposes no change** (updated 2026-11-10 08:50:49 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-career-repair-sonnet-low-converge`
- Command: `node scripts/claude-effort-ladder.mjs capture-career --source ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-09-career-capture/src/career data.md --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-career-repair-sonnet-low-converge --ladder-tasks career-profile-repair --configs haiku:low --reps 1 --concurrency 3 --max-calls 0 --baseline-from ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-09-career-capture/base2 --live-on-miss --profile-override career-profile-repair=sonnet:low`

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| production baseline | 28 | 12 |  | $0.602 | 6 repairs |
| ladder cells | 7 | 6 | 0 | $0.037 | per-config rows: summarize --out |

Recorded cost so far: $0.639.
<!-- /ai-test-run:2026-11-10T08-42-41-976Z-claude-effort-laddercapture-career-dcd6b2 -->

<!-- ai-test-run:2026-11-10T08-48-20-922Z-claude-effort-laddercapture-career-1941ed -->
### 2026-11-10 08:48 UTC · claude-effort-ladder capture-career · career-profile-audit-metrics · haiku:low

- Status: **finished** (updated 2026-11-10 08:57:05 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-career-audit-metrics-haiku-low-converge-2`
- Command: `node scripts/claude-effort-ladder.mjs capture-career --source ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-09-career-capture/src/career data.md --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-career-audit-metrics-haiku-low-converge-2 --ladder-tasks career-profile-audit-metrics --configs haiku:low --reps 1 --concurrency 3 --max-calls 0 --baseline-from ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-09-career-capture/base2 --live-on-miss --profile-override career-profile-audit-metrics=haiku:low`

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| production baseline | 119 | 40 |  | $0.356 | 0 repairs |
| ladder cells | 18 | 18 | 0 | $0.073 | per-config rows: summarize --out |

Recorded cost so far: $0.429.
<!-- /ai-test-run:2026-11-10T08-48-20-922Z-claude-effort-laddercapture-career-1941ed -->

<!-- ai-test-run:2026-11-10T08-48-20-921Z-claude-effort-laddercapture-career-a93977 -->
### 2026-11-10 08:48 UTC · claude-effort-ladder capture-career · career-profile-audit-metrics · haiku:low

- Status: **finished** (updated 2026-11-10 09:01:29 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-career-audits-production-control-converge`
- Command: `node scripts/claude-effort-ladder.mjs capture-career --source ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-09-career-capture/src/career data.md --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-career-audits-production-control-converge --ladder-tasks career-profile-audit-metrics --configs haiku:low --reps 1 --concurrency 3 --max-calls 0 --baseline-from ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-09-career-capture/base2 --live-on-miss --profile-override career-profile-audit-metrics=haiku:medium --profile-override career-profile-audit-grounding=haiku:medium --profile-override career-profile-audit-attribution=haiku:medium --profile-override career-profile-audit-conflicts=haiku:medium --profile-override career-profile-audit-completeness=haiku:medium`

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| production baseline | 122 | 103 |  | $0.849 | 2 repairs |
| ladder cells | 18 | 18 | 0 | $0.073 | per-config rows: summarize --out |

Recorded cost so far: $0.922.
<!-- /ai-test-run:2026-11-10T08-48-20-921Z-claude-effort-laddercapture-career-a93977 -->

<!-- ai-test-run:2026-11-10T08-55-15-518Z-blindjudge3Offloadreportjobspackets5757-6a2f48 -->
### 2026-11-10 08:55 UTC · blind judge (3 Offload report jobs, packets 57/57) · qa-brief · 4 real Prepare prompts (Stripe, Reddit, Appian, InTouch), replayed

- Status: **finished: Opus low passes (within noise of the production rerun)** (updated 2026-11-10 08:55:15 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-interview-prepare-saved`

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| production archived | 4 |  |  | $0.000 | 9, 8, 9, 9 (8.75) |
| opus:medium rerun | 4 |  |  | $0.761 | 8, 9, 9, 6 (8.0): same-harness reference |
| opus:low | 4 |  |  | $0.466 | 8, 8, 8, 6 (7.5): within 0.75 noise |
| sonnet:medium | 4 |  |  | $0.254 | 7, 7, 6, 8 (7.0) |
| haiku:medium | 4 |  |  | $0.037 | 6, 7, 7, 8 (7.0) |

Recorded cost so far: $1.518.
- Note: Noise floor = archived production vs same-setting rerun (0.75). Compared to the same-harness rerun, as for editorial-plan.
<!-- /ai-test-run:2026-11-10T08-55-15-518Z-blindjudge3Offloadreportjobspackets5757-6a2f48 -->

<!-- ai-test-run:2026-11-10T08-55-15-558Z-blindjudgeOffloadreportpacket2525-d37876 -->
### 2026-11-10 08:55 UTC · blind judge (Offload report, packet 25/25) · qa-write · 2 real answer banks (Stripe, Reddit), replayed

- Status: **finished: every cheaper setting fails; qa-write stays Opus medium** (updated 2026-11-10 08:55:15 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-interview-prepare-saved`

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| production archived | 2 |  |  | $0.000 | 8, 8 (8.0) |
| opus:medium rerun | 2 |  |  | $2.477 | 9, 9 (9.0) |
| sonnet:medium | 2 |  |  | $1.254 | 7, 7 (7.0) |
| opus:low | 2 |  |  | $1.439 | 6, 6 (6.0); inflated agency |
| haiku:medium | 2 | 1 | 1 | $0.240 | 5, 1 (unparseable Reddit bank) |

Recorded cost so far: $5.410.
<!-- /ai-test-run:2026-11-10T08-55-15-558Z-blindjudgeOffloadreportpacket2525-d37876 -->

<!-- ai-test-run:2026-11-10T09-01-45-698Z-claude-effort-laddercapture-career-31ca7f -->
### 2026-11-10 09:01 UTC · claude-effort-ladder capture-career · career-profile-audit-metrics · haiku:low

- Status: **failed: Career profile page-0003 is invalid: edit 0 (set achievements/p0003-ach-flitex-a-star-routing/technologies): edit to achievements/p0003-ach-flitex-a-star-routing/technologies proposes no change | edit 1 (set projects/p0003-project-marketplace-hub/technologies): edit to projects/p0003-project-marketplace-hub/technologies proposes no change** (updated 2026-11-10 09:15:38 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-career-audits-haiku-low-converge-2`
- Command: `node scripts/claude-effort-ladder.mjs capture-career --source ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-09-career-capture/src/career data.md --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-career-audits-haiku-low-converge-2 --ladder-tasks career-profile-audit-metrics --configs haiku:low --reps 1 --concurrency 3 --max-calls 0 --baseline-from ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-09-career-capture/base2 --live-on-miss --profile-override career-profile-audit-metrics=haiku:low --profile-override career-profile-audit-grounding=haiku:low --profile-override career-profile-audit-attribution=haiku:low --profile-override career-profile-audit-conflicts=haiku:low --profile-override career-profile-audit-completeness=haiku:low`

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| production baseline | 126 | 111 |  | $1.294 | 4 repairs |
| ladder cells | 18 | 18 | 0 | $0.072 | per-config rows: summarize --out |

Recorded cost so far: $1.366.
<!-- /ai-test-run:2026-11-10T09-01-45-698Z-claude-effort-laddercapture-career-31ca7f -->

<!-- ai-test-run:2026-11-10T09-26-53-670Z-planteddefectscleanreplayscompileconvergence-7b28af -->
### 2026-11-10 09:26 UTC · planted defects + clean replays + compile convergence · career-profile-audit-metrics, -grounding, -attribution, -conflicts, -completeness · haiku:low vs haiku:medium (production), references haiku:high and sonnet:medium

- Status: **finished: all five stay Haiku medium** (updated 2026-11-10 09:26:53 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-career-audits-planted`

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| planted defects haiku:low | 60 | 59 |  | $0.147 | metrics 12/12, grounding 12/12, attribution 11/12, conflicts 12/12, completeness 12/12 |
| planted defects haiku:medium (production) | 60 | 58 |  | $0.159 | 12, 12, 10, 12, 12 of 12 |
| planted defects haiku:high | 60 | 59 |  | $0.193 | 12, 12, 11, 12, 12 |
| planted defects sonnet:medium | 60 | 60 |  | $1.525 | 12 everywhere |
| clean real prompts (false alarms) | 60 |  |  | $0.253 | haiku:low 3 findings, haiku:medium 2, production 3 on 30 prompts each: equal |
| compile, one audit at haiku:low | 6 | 6 |  | $2.740 | each finishes: metrics 3 and 6 rounds, conflicts 5, grounding 6, completeness 6, attribution 7; production 2, 4 and 6 |
| compile, all five at haiku:low | 2 | 0 | 2 | $1.860 | both stalled: page-0003 technology edits that propose no change |
| compile, all five at haiku:medium (control) | 1 | 1 |  | $0.920 | finished in 6 rounds |

Recorded cost so far: $7.797.
- Note: Applying Haiku low means switching all five together, which failed 2 of 2. Leave-one-out runs could find the culprit, but the most it could save is under $1 a year per audit.
<!-- /ai-test-run:2026-11-10T09-26-53-670Z-planteddefectscleanreplayscompileconvergence-7b28af -->

<!-- ai-test-run:2026-11-10T09-26-53-708Z-compileconvergence-34327e -->
### 2026-11-10 09:26 UTC · compile convergence · career-profile-repair · haiku:low, haiku:medium, haiku:high vs sonnet:low (production)

- Status: **finished: repair stays Sonnet low** (updated 2026-11-10 09:26:53 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-career-repair-sonnet-low-converge`

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| sonnet:low (production) | 3 | 2 | 1 | $0.585 | 2 of 3 compiles finished (11-09 x2); the live control failed on one no-change edit |
| haiku:low | 1 | 0 | 1 | $0.050 | looped: a repair undid an earlier one |
| haiku:medium | 1 | 0 | 1 | $0.080 | same loop |
| haiku:high | 1 | 0 | 1 | $0.235 | invalid technologyReferences |

Recorded cost so far: $0.950.
- Note: Per-call validity was fine (Haiku low/medium 6/6); the failure is downstream. Production's one failure means a single no-change repair edit can stop a career compile: an app weakness worth fixing separately.
<!-- /ai-test-run:2026-11-10T09-26-53-708Z-compileconvergence-34327e -->

<!-- ai-test-run:2026-11-10T10-43-40-160Z-claude-effort-ladderrun-e625c6 -->
### 2026-11-10 10:43 UTC · claude-effort-ladder run · career-profile-clean · haiku:low, haiku:medium, sonnet:low

- Status: **interrupted (SIGTERM) before finishing; rows above are complete up to that point** (updated 2026-11-10 10:48:51 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-career-clean/run`
- Command: `node scripts/claude-effort-ladder.mjs run --records ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-career-clean/records.jsonl --configs haiku:low,haiku:medium,sonnet:low --reps 2 --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-career-clean/run --concurrency 3`
- Records: 3 from ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-career-clean/records.jsonl
- Reps: 2

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| career-profile-clean haiku:low | 2 | 1 | 0 | $0.103 |  |
| career-profile-clean haiku:medium | 1 | 1 | 0 | $0.052 |  |

Recorded cost so far: $0.155.
<!-- /ai-test-run:2026-11-10T10-43-40-160Z-claude-effort-ladderrun-e625c6 -->

<!-- ai-test-run:2026-11-10T10-50-46-222Z-claude-effort-ladderrun-ddb4a1 -->
### 2026-11-10 10:50 UTC · claude-effort-ladder run · career-profile-clean · haiku:low, haiku:medium, sonnet:low

- Status: **finished** (updated 2026-11-10 11:11:59 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-career-clean/run`
- Command: `node scripts/claude-effort-ladder.mjs run --records ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-career-clean/records.jsonl --configs haiku:low,haiku:medium,sonnet:low --reps 2 --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-career-clean/run --concurrency 3`
- Records: 3 from ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-career-clean/records.jsonl
- Reps: 2

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| career-profile-clean haiku:low | 6 | 4 | 0 | $0.271 |  |
| career-profile-clean haiku:medium | 6 | 4 | 0 | $0.281 |  |
| career-profile-clean sonnet:low | 6 | 6 | 0 | $5.122 |  |

Recorded cost so far: $5.674.
<!-- /ai-test-run:2026-11-10T10-50-46-222Z-claude-effort-ladderrun-ddb4a1 -->

<!-- ai-test-run:2026-11-10T11-36-23-919Z-claude-effort-ladder-92dd0d -->
### 2026-11-10 11:36 UTC · claude-effort-ladder · career-profile-clean · career-profile-clean ladder, 3 full-catalog prompts x2

- Status: **finished** (updated 2026-11-10 11:36:23 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-career-clean/run`

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| haiku:low (production) | 6 | 3 | 3 | $0.272 | 3 unusable: 2 answered a bare array (schema), 1 cut off at 198/1110 rows; fixes reproduced 6/26 on usable answers |
| haiku:medium | 6 | 3 | 3 | $0.281 | 2 bare array, 1 cut off at 457/1124 rows |
| sonnet:low | 6 | 6 | 0 | $5.122 | all rows present and verified; reproduced 12/54 of production's spelling edits, 0 extra edits |

Recorded cost so far: $5.674.
- Note: Prompts are the worst case (whole catalog, ~1,100 rows, one page; production normally re-cleans only changed rows). Whether the app retries a schema-rejected answer is still to be checked before a verdict.
<!-- /ai-test-run:2026-11-10T11-36-23-919Z-claude-effort-ladder-92dd0d -->

<!-- ai-test-run:2026-11-10T11-51-43-367Z-official-lookup-measure-9d00ae -->
### 2026-11-10 11:51 UTC · official-lookup-measure · job-official-posting-research · official lookup on 29 ZipRecruiter rows (Oct 28 canvas)

- Status: **finished** (updated 2026-11-10 11:51:43 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-ziprecruiter-official-lookup`

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| production (opus/low research, sonnet/medium judges) | 29 | 6 | 23 | $15.40 | 5 found with full description (CARFAX, Envisio, Disney, Remarcable, Syndesus), 1 link-only (AssemblyAI); 620 s for all 29 at app concurrency; research 5 batched calls $2.48, judges 74 calls $12.93 (3 failed) |

Recorded cost so far: $15.40.
- Note: Rows are 13 days old (many postings likely removed), pages downloaded without browser rendering, 4 of 29 are recruiting agencies and 1 anonymous. Per-row outcomes for unsaved rows were not captured (harness bug); unsaved = not confirmed.
<!-- /ai-test-run:2026-11-10T11-51-43-367Z-official-lookup-measure-9d00ae -->

<!-- ai-test-run:2026-11-10T12-02-23-961Z-official-lookup-measure-cfec70 -->
### 2026-11-10 12:02 UTC · official-lookup-measure · job-official-posting-research · ZipRecruiter official lookup, final numbers

- Status: **finished** (updated 2026-11-10 12:02:23 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-ziprecruiter-official-lookup`
- agencies: 4-clear+4-likely
- unnamed: 1

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| production | 29 | 6 | 23 | $15.40 | found 6/29 = 21% (5 with full JD); $0.53 per job; 620 s wall for 29 at app concurrency = 21 s/job (70 s for one job alone); 74 judge calls $12.93 = 84% of cost |

Recorded cost so far: $15.40.
- Note: Run completed all 29 rows (progress 29/29, 79 calls, 3 judge answers rejected). Clear agencies: STACK IT Recruitment, Tech Talent International, Motion Recruitment, PRAGMATIKE; likely staffing: Mercor, NearSource, High Tech Genesis, Onsite It Advisors; unnamed: 'Behavioral Health Technology company'. STACK IT was found in the 1-job smoke run but not in the full run (run-to-run variance). Why the 22 unsaved rows failed was not captured; not re-run to avoid redoing finished jobs.
<!-- /ai-test-run:2026-11-10T12-02-23-961Z-official-lookup-measure-cfec70 -->

<!-- ai-test-run:2026-11-10T16-51-28-133Z-career-clean-validator-retest-913578 -->
### 2026-11-10 16:51 UTC · career-clean-validator-retest · career-profile-clean · career-profile-clean re-test at Haiku low with the new missing-row check (validateCareerCleanPage), same 3 full-catalog pages x2

- Status: **finished** (updated 2026-11-10 16:51:28 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-career-clean-validator`

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| haiku:low + missing-row check | 6 | 6 | 0 | $0.258 | all 6 complete on the first try (0 retries, 0 rejected rows); reproduced 12/54 production spelling edits = same as Sonnet low (12/54, $5.12) |

Recorded cost so far: $0.258.
<!-- /ai-test-run:2026-11-10T16-51-28-133Z-career-clean-validator-retest-913578 -->

<!-- ai-test-run:2026-11-10T17-03-56-530Z-finder-location-24-a185dc -->
### 2026-11-10 17:03 UTC · finder-location-24 · job-official-posting-research · resolveOfficialPostings as location source on the 24 cards of the 2026-11-09 location lookup A/B (consolidation plan step 1)

- Status: **finished** (updated 2026-11-10 17:03:56 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-finder-location-24`

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| finder (research opus/low + 2 judges) | 24 | 9 | 0 | $17.17 | 9 correct (PlayStation scored wrong by the matcher only for word order: Waterloo, ON, Canada vs Canada, Waterloo, ON), 0 truly wrong, 15 not found; 91 calls (1 failed), 792 s for all 24; found 5 the lookup missed (Zafin, Fellow, StreamingFast, AssemblyAI, Dropbox), missed 3 the lookup found (CARFAX, Doppel, Affirm); union 12. Caveat: truth came from earlier finder runs, so the set favours the finder |
| old lookup merged (2026-11-09, for reference) | 24 | 7 | 0 | $11.15 | built-in $4.12 + Tavily $7.03 |

Recorded cost so far: $28.32.
<!-- /ai-test-run:2026-11-10T17-03-56-530Z-finder-location-24-a185dc -->

<!-- ai-test-run:2026-11-10T19-33-15-468Z-finder-location-24-threeway-961ad4 -->
### 2026-11-10 19:33 UTC · finder-location-24-threeway · job-official-posting-research · Rerun of the 24 location cards with the finder searching as the app does (built-in + Claude/Tavily + plain Tavily, merged); the earlier run was built-in only

- Status: **finished** (updated 2026-11-10 19:33:15 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-finder-location-24-threeway`

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| finder three-way (as the app) | 24 | 15 | 0 | $19.41 | 15 correct (PlayStation matcher-wrong for word order only), 0 truly wrong, 9 not found; 76 calls, 0 failed, 614 s; research $5.72 of it; vs built-in-only finder 9, lookup 7; misses Doppel and Affirm that the lookup found; union with lookup 17 |
| finder built-in only (earlier today) | 24 | 9 | 0 | $17.17 | harness bypassed the worker's three-way search |
| old lookup merged (2026-11-09) | 24 | 7 | 0 | $11.15 | reference |

Recorded cost so far: $47.73.
<!-- /ai-test-run:2026-11-10T19-33-15-468Z-finder-location-24-threeway-961ad4 -->

<!-- ai-test-run:2026-11-11T01-41-59-770Z-claude-effort-ladderrun-6f5214 -->
### 2026-11-11 01:41 UTC · claude-effort-ladder run · job-taxonomy-plan · haiku:low, sonnet:medium

- Status: **finished** (updated 2026-11-11 01:42:11 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-board-run-calls/job-taxonomy-plan`
- Command: `node scripts/claude-effort-ladder.mjs run --records ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-board-run-calls/job-taxonomy-plan.records.jsonl --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-board-run-calls/job-taxonomy-plan --configs haiku:low,sonnet:medium --reps 2 --concurrency 4`
- Records: 1 from ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-board-run-calls/job-taxonomy-plan.records.jsonl
- Reps: 2

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| job-taxonomy-plan haiku:low | 2 | 2 | 0 | $0.004 |  |
| job-taxonomy-plan sonnet:medium | 2 | 2 | 0 | $0.041 |  |

Recorded cost so far: $0.045.
<!-- /ai-test-run:2026-11-11T01-41-59-770Z-claude-effort-ladderrun-6f5214 -->

<!-- ai-test-run:2026-11-11T01-41-59-783Z-claude-effort-ladderrun-752acd -->
### 2026-11-11 01:41 UTC · claude-effort-ladder run · job-location-consolidation-confirmation · haiku:low, haiku:medium, sonnet:low, sonnet:medium, opus:low

- Status: **finished** (updated 2026-11-11 01:42:14 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-board-run-calls/job-location-consolidation-confirmation`
- Command: `node scripts/claude-effort-ladder.mjs run --records ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-board-run-calls/job-location-consolidation-confirmation.records.jsonl --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-board-run-calls/job-location-consolidation-confirmation --configs haiku:low,haiku:medium,sonnet:low,sonnet:medium,opus:low --reps 2 --concurrency 4`
- Records: 1 from ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-board-run-calls/job-location-consolidation-confirmation.records.jsonl
- Reps: 2

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| job-location-consolidation-confirmation haiku:low | 2 | 2 | 0 | $0.004 |  |
| job-location-consolidation-confirmation haiku:medium | 2 | 2 | 0 | $0.004 |  |
| job-location-consolidation-confirmation opus:low | 2 | 2 | 0 | $0.073 |  |
| job-location-consolidation-confirmation sonnet:low | 2 | 2 | 0 | $0.036 |  |
| job-location-consolidation-confirmation sonnet:medium | 2 | 2 | 0 | $0.036 |  |

Recorded cost so far: $0.153.
<!-- /ai-test-run:2026-11-11T01-41-59-783Z-claude-effort-ladderrun-752acd -->

<!-- ai-test-run:2026-11-11T01-41-59-775Z-claude-effort-ladderrun-1fe612 -->
### 2026-11-11 01:41 UTC · claude-effort-ladder run · job-role-screen-batch · haiku:low, sonnet:medium

- Status: **finished** (updated 2026-11-11 01:45:10 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-board-run-calls/job-role-screen-batch`
- Command: `node scripts/claude-effort-ladder.mjs run --records ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-board-run-calls/job-role-screen-batch.records.jsonl --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-board-run-calls/job-role-screen-batch --configs haiku:low,sonnet:medium --reps 2 --concurrency 4`
- Records: 2 from ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-board-run-calls/job-role-screen-batch.records.jsonl
- Reps: 2

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| job-role-screen-batch haiku:low | 4 | 4 | 0 | $0.060 |  |
| job-role-screen-batch sonnet:medium | 4 | 4 | 0 | $0.945 |  |

Recorded cost so far: $1.005.
<!-- /ai-test-run:2026-11-11T01-41-59-775Z-claude-effort-ladderrun-1fe612 -->

<!-- ai-test-run:2026-11-11T01-45-10-288Z-claude-effort-ladderrun-10f8db -->
### 2026-11-11 01:45 UTC · claude-effort-ladder run · job-preference-interpretation · haiku:low, haiku:medium, sonnet:medium

- Status: **finished** (updated 2026-11-11 01:48:03 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-board-run-calls/job-preference-interpretation`
- Command: `node scripts/claude-effort-ladder.mjs run --records ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-board-run-calls/job-preference-interpretation.records.jsonl --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-board-run-calls/job-preference-interpretation --configs haiku:low,haiku:medium,sonnet:medium --reps 2 --concurrency 4`
- Records: 4 from ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-board-run-calls/job-preference-interpretation.records.jsonl
- Reps: 2

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| job-preference-interpretation haiku:low | 8 | 8 | 0 | $0.062 |  |
| job-preference-interpretation haiku:medium | 8 | 7 | 0 | $0.073 |  |
| job-preference-interpretation sonnet:medium | 8 | 8 | 0 | $0.506 |  |

Recorded cost so far: $0.640.
<!-- /ai-test-run:2026-11-11T01-45-10-288Z-claude-effort-ladderrun-10f8db -->

<!-- ai-test-run:2026-11-11T01-45-10-288Z-claude-effort-ladderrun-c3ec53 -->
### 2026-11-11 01:45 UTC · claude-effort-ladder run · job-role-audit · haiku:low, haiku:medium, haiku:high, sonnet:low, sonnet:medium

- Status: **finished** (updated 2026-11-11 01:46:41 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-board-run-calls/job-role-audit`
- Command: `node scripts/claude-effort-ladder.mjs run --records ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-board-run-calls/job-role-audit.records.jsonl --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-board-run-calls/job-role-audit --configs haiku:low,haiku:medium,haiku:high,sonnet:low,sonnet:medium --reps 2 --concurrency 4`
- Records: 4 from ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-board-run-calls/job-role-audit.records.jsonl
- Reps: 2

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| job-role-audit haiku:high | 8 | 7 | 0 | $0.038 |  |
| job-role-audit haiku:low | 8 | 8 | 0 | $0.034 |  |
| job-role-audit haiku:medium | 8 | 7 | 0 | $0.034 |  |
| job-role-audit sonnet:low | 8 | 5 | 0 | $0.353 |  |
| job-role-audit sonnet:medium | 8 | 2 | 0 | $0.372 |  |

Recorded cost so far: $0.831.
<!-- /ai-test-run:2026-11-11T01-45-10-288Z-claude-effort-ladderrun-c3ec53 -->

<!-- ai-test-run:2026-11-11T01-48-03-701Z-claude-effort-ladderrun-aececc -->
### 2026-11-11 01:48 UTC · claude-effort-ladder run · job-gap-review · haiku:medium, haiku:high, sonnet:low, sonnet:medium, sonnet:high

- Status: **finished** (updated 2026-11-11 01:48:27 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-board-run-calls/job-gap-review`
- Command: `node scripts/claude-effort-ladder.mjs run --records ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-board-run-calls/job-gap-review.records.jsonl --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-board-run-calls/job-gap-review --configs haiku:medium,haiku:high,sonnet:low,sonnet:medium,sonnet:high --reps 2 --concurrency 4`
- Records: 1 from ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-board-run-calls/job-gap-review.records.jsonl
- Reps: 2

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| job-gap-review haiku:high | 2 | 2 | 0 | $0.020 |  |
| job-gap-review haiku:medium | 2 | 1 | 0 | $0.019 |  |
| job-gap-review sonnet:high | 2 | 2 | 0 | $0.214 |  |
| job-gap-review sonnet:low | 2 | 2 | 0 | $0.203 |  |
| job-gap-review sonnet:medium | 2 | 2 | 0 | $0.209 |  |

Recorded cost so far: $0.666.
<!-- /ai-test-run:2026-11-11T01-48-03-701Z-claude-effort-ladderrun-aececc -->

<!-- ai-test-run:2026-11-11T01-48-03-700Z-claude-effort-ladderrun-c5c7ae -->
### 2026-11-11 01:48 UTC · claude-effort-ladder run · job-preference-research-batch-assessment · haiku:medium, haiku:high, sonnet:low, sonnet:medium, sonnet:high

- Status: **finished** (updated 2026-11-11 01:49:47 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-board-run-calls/job-preference-research-batch-assessment`
- Command: `node scripts/claude-effort-ladder.mjs run --records ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-board-run-calls/job-preference-research-batch-assessment.records.jsonl --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-board-run-calls/job-preference-research-batch-assessment --configs haiku:medium,haiku:high,sonnet:low,sonnet:medium,sonnet:high --reps 2 --concurrency 4`
- Records: 1 from ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-board-run-calls/job-preference-research-batch-assessment.records.jsonl
- Reps: 2

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| job-preference-research-batch-assessment haiku:high | 2 | 2 | 0 | $0.026 |  |
| job-preference-research-batch-assessment haiku:medium | 2 | 2 | 0 | $0.021 |  |
| job-preference-research-batch-assessment sonnet:high | 2 | 2 | 0 | $0.203 |  |
| job-preference-research-batch-assessment sonnet:low | 2 | 2 | 0 | $0.146 |  |
| job-preference-research-batch-assessment sonnet:medium | 2 | 2 | 0 | $0.146 |  |

Recorded cost so far: $0.541.
<!-- /ai-test-run:2026-11-11T01-48-03-700Z-claude-effort-ladderrun-c5c7ae -->

<!-- ai-test-run:2026-11-11T01-54-38-473Z-claude-effort-ladderrun-0f860e -->
### 2026-11-11 01:54 UTC · claude-effort-ladder run · job-location-consolidation-confirmation · haiku:low, haiku:medium, sonnet:low, opus:low

- Status: **finished** (updated 2026-11-11 01:55:07 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-board-run-calls/job-location-consolidation-planted`
- Command: `node scripts/claude-effort-ladder.mjs run --records ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-board-run-calls/job-location-consolidation-planted.records.jsonl --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-board-run-calls/job-location-consolidation-planted --configs haiku:low,haiku:medium,sonnet:low,opus:low --reps 2 --concurrency 4`
- Records: 2 from ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-board-run-calls/job-location-consolidation-planted.records.jsonl
- Reps: 2

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| job-location-consolidation-confirmation haiku:low | 4 | 0 | 0 | $0.018 |  |
| job-location-consolidation-confirmation haiku:medium | 4 | 0 | 0 | $0.018 |  |
| job-location-consolidation-confirmation opus:low | 4 | 0 | 0 | $0.350 |  |
| job-location-consolidation-confirmation sonnet:low | 4 | 0 | 0 | $0.186 |  |

Recorded cost so far: $0.572.
<!-- /ai-test-run:2026-11-11T01-54-38-473Z-claude-effort-ladderrun-0f860e -->

<!-- ai-test-run:2026-11-11T01-55-40-339Z-claude-effort-ladderrun-ccfefd -->
### 2026-11-11 01:55 UTC · claude-effort-ladder run · job-location-consolidation-confirmation · haiku:low, haiku:medium, sonnet:low, opus:low

- Status: **finished** (updated 2026-11-11 01:56:07 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-board-run-calls/job-location-consolidation-subtle`
- Command: `node scripts/claude-effort-ladder.mjs run --records ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-board-run-calls/job-location-consolidation-subtle.records.jsonl --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-board-run-calls/job-location-consolidation-subtle --configs haiku:low,haiku:medium,sonnet:low,opus:low --reps 2 --concurrency 4`
- Records: 2 from ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-board-run-calls/job-location-consolidation-subtle.records.jsonl
- Reps: 2

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| job-location-consolidation-confirmation haiku:low | 4 | 4 | 0 | $0.012 |  |
| job-location-consolidation-confirmation haiku:medium | 4 | 4 | 0 | $0.013 |  |
| job-location-consolidation-confirmation opus:low | 4 | 4 | 0 | $0.252 |  |
| job-location-consolidation-confirmation sonnet:low | 4 | 4 | 0 | $0.122 |  |

Recorded cost so far: $0.399.
<!-- /ai-test-run:2026-11-11T01-55-40-339Z-claude-effort-ladderrun-ccfefd -->

<!-- ai-test-run:2026-11-11T02-03-42-152Z-blindjudgeDeepSeekFlashreportjob-49158a -->
### 2026-11-11 02:03 UTC · blind judge (DeepSeek Flash report job) · job-role-screen-batch

- Status: **finished** (updated 2026-11-11 02:03:42 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-board-run-calls`

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| haiku:low (production) | 124 | 124 | 0 | $0.000 | judge: 104 right, 15 acceptable, 5 wrong (all wrong mismatches) |
| sonnet:medium rep 1 | 124 | 124 | 0 | $0.000 | judge: 17 right, 75 acceptable, 32 wrong (all wrong mismatches that drop a real job) |

Recorded cost so far: $0.000.
- Note: 124 rows sampled from 320 verdicts where production and Sonnet medium disagreed on the 1,970-title real prompt. Haiku low rerun agreed with production on 95.0% of verdicts, Sonnet medium on 68.0%.
<!-- /ai-test-run:2026-11-11T02-03-42-152Z-blindjudgeDeepSeekFlashreportjob-49158a -->

<!-- ai-test-run:2026-11-11T02-03-42-209Z-blindjudgeDeepSeekFlashreportjob-00dd0d -->
### 2026-11-11 02:03 UTC · blind judge (DeepSeek Flash report job) · job-taxonomy-plan

- Status: **finished** (updated 2026-11-11 02:03:42 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-board-run-calls`

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| haiku:low (production) | 1 | 1 | 0 | $0.000 | judge 9/10 |
| haiku:low rerun | 1 | 1 | 0 | $0.000 | judge 8/10: one unreachable family |
| sonnet:medium | 1 | 1 | 0 | $0.000 | judge 5/10: fenced JSON, Security and Eng Management in Other, 109k-wide band |

Recorded cost so far: $0.000.
<!-- /ai-test-run:2026-11-11T02-03-42-209Z-blindjudgeDeepSeekFlashreportjob-00dd0d -->

<!-- ai-test-run:2026-11-11T02-03-42-260Z-blindjudgeDeepSeekFlashreportjob-add503 -->
### 2026-11-11 02:03 UTC · blind judge (DeepSeek Flash report job) · job-preference-interpretation

- Status: **finished** (updated 2026-11-11 02:03:42 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-board-run-calls`

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| haiku:medium (production) | 1 | 1 | 0 | $0.000 | judge 8/10: fintech carve-out turned into a preference |
| haiku:low | 1 | 1 | 0 | $0.000 | judge 7/10: competitive pay merged into a company item |
| sonnet:medium | 1 | 1 | 0 | $0.000 | judge 6/10: title priority missing, only-when title conditions made soft (changes filtering) |

Recorded cost so far: $0.000.
<!-- /ai-test-run:2026-11-11T02-03-42-260Z-blindjudgeDeepSeekFlashreportjob-add503 -->

<!-- ai-test-run:2026-11-11T02-03-42-322Z-blindjudgeDeepSeekFlashreportjob-d66ae5 -->
### 2026-11-11 02:03 UTC · blind judge (DeepSeek Flash report job) · job-role-audit

- Status: **finished** (updated 2026-11-11 02:03:42 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-board-run-calls`

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| case X: draft with Senior titles | 1 | 1 | 0 | $0.000 | keep them; removing = clear rule violation (Haiku low, Sonnet low did) |
| case Y: bare Software Engineer | 1 | 1 | 0 | $0.000 | remove it (production, Haiku low); keeping = defensible judgment call |

Recorded cost so far: $0.000.
<!-- /ai-test-run:2026-11-11T02-03-42-322Z-blindjudgeDeepSeekFlashreportjob-d66ae5 -->

<!-- ai-test-run:2026-11-11T02-03-42-375Z-plantedpairsclaude-effort-ladderrun-aa72dd -->
### 2026-11-11 02:03 UTC · planted pairs (claude-effort-ladder run) · job-location-consolidation-confirmation

- Status: **finished** (updated 2026-11-11 02:03:42 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-10-board-run-calls`

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| haiku:low | 40 | 40 | 0 | $0.030 | 40/40 decisions correct |
| haiku:medium | 40 | 40 | 0 | $0.031 | 40/40 correct |
| sonnet:low | 40 | 38 | 0 | $0.308 | 38/40: split the boilerplate-only control twice |
| opus:low (production) | 40 | 39 | 0 | $0.602 | 39/40: split the boilerplate-only control once |

Recorded cost so far: $0.971.
- Note: n and valid count pair decisions. Blunt round (seniority, employment type, team, location-only control) packed 6 pairs per prompt, over the schema's 4-pair cap, so the ladder marked those calls invalid; decisions were scored from the answers. Subtle round (stack, level, separate requisition, boilerplate control) stayed within the cap and was valid.
<!-- /ai-test-run:2026-11-11T02-03-42-375Z-plantedpairsclaude-effort-ladderrun-aa72dd -->

<!-- ai-test-run:2026-11-12T22-04-14-957Z-claude-effort-ladderrun-861ca5 -->
### 2026-11-12 22:04 UTC · claude-effort-ladder run · job-listing-liveness · haiku:low, haiku:medium, sonnet:medium

- Status: **finished** (updated 2026-11-12 22:07:32 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-12-policy-gap-calls/runs/liveness`
- Command: `node scripts/claude-effort-ladder.mjs run --records ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-12-policy-gap-calls/records/liveness.jsonl --configs haiku:low,haiku:medium,sonnet:medium --reps 2 --concurrency 3 --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-12-policy-gap-calls/runs/liveness`
- Records: 13 from ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-12-policy-gap-calls/records/liveness.jsonl
- Reps: 2

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| job-listing-liveness haiku:low | 26 | 26 | 0 | $0.061 |  |
| job-listing-liveness haiku:medium | 26 | 26 | 0 | $0.063 |  |
| job-listing-liveness sonnet:medium | 26 | 26 | 0 | $0.648 |  |

Recorded cost so far: $0.771.
<!-- /ai-test-run:2026-11-12T22-04-14-957Z-claude-effort-ladderrun-861ca5 -->

<!-- ai-test-run:2026-11-12T22-04-14-956Z-claude-effort-ladderrun-61e678 -->
### 2026-11-12 22:04 UTC · claude-effort-ladder run · interview-answer-repair · opus:high, haiku:high, sonnet:medium, sonnet:high, opus:low, opus:medium

- Status: **finished** (updated 2026-11-12 22:27:28 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-12-policy-gap-calls/runs/qa-card-repair`
- Command: `node scripts/claude-effort-ladder.mjs run --records ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-12-policy-gap-calls/records/qa-card-repair.jsonl --configs opus:high,haiku:high,sonnet:medium,sonnet:high,opus:low,opus:medium --reps 2 --concurrency 3 --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-12-policy-gap-calls/runs/qa-card-repair`
- Records: 2 from ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-12-policy-gap-calls/records/qa-card-repair.jsonl
- Reps: 2

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| interview-answer-repair haiku:high | 4 | 4 | 0 | $0.130 |  |
| interview-answer-repair opus:high | 4 | 4 | 0 | $2.021 |  |
| interview-answer-repair opus:low | 4 | 4 | 0 | $1.340 |  |
| interview-answer-repair opus:medium | 4 | 4 | 0 | $1.624 |  |
| interview-answer-repair sonnet:high | 4 | 4 | 0 | $1.335 |  |
| interview-answer-repair sonnet:medium | 4 | 4 | 0 | $0.878 |  |

Recorded cost so far: $7.328.
<!-- /ai-test-run:2026-11-12T22-04-14-956Z-claude-effort-ladderrun-61e678 -->

<!-- ai-test-run:2026-11-12T22-04-14-956Z-claude-effort-ladderrun-b15a08 -->
### 2026-11-12 22:04 UTC · claude-effort-ladder run · job-role-screen-batch · haiku:low, haiku:medium, sonnet:medium

- Status: **finished** (updated 2026-11-12 22:16:24 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-12-policy-gap-calls/runs/role-screen`
- Command: `node scripts/claude-effort-ladder.mjs run --records ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-12-policy-gap-calls/records/role-screen.jsonl --configs haiku:low,haiku:medium,sonnet:medium --reps 2 --concurrency 3 --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-12-policy-gap-calls/runs/role-screen`
- Records: 2 from ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-12-policy-gap-calls/records/role-screen.jsonl
- Reps: 2

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| job-role-screen-batch haiku:low | 4 | 4 | 0 | $0.144 |  |
| job-role-screen-batch haiku:medium | 4 | 4 | 0 | $0.189 |  |
| job-role-screen-batch sonnet:medium | 4 | 4 | 0 | $0.890 |  |

Recorded cost so far: $1.223.
<!-- /ai-test-run:2026-11-12T22-04-14-956Z-claude-effort-ladderrun-b15a08 -->

<!-- ai-test-run:2026-11-12T22-04-14-956Z-claude-effort-ladderrun-ed0dd9 -->
### 2026-11-12 22:04 UTC · claude-effort-ladder run · job-compensation-assessment-batch · opus:low, haiku:medium, haiku:high, sonnet:low, sonnet:medium, sonnet:high

- Status: **finished** (updated 2026-11-12 22:20:42 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-12-policy-gap-calls/runs/comp-assessment`
- Command: `node scripts/claude-effort-ladder.mjs run --records ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-12-policy-gap-calls/records/comp-assessment.jsonl --configs opus:low,haiku:medium,haiku:high,sonnet:low,sonnet:medium,sonnet:high --reps 2 --concurrency 3 --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-12-policy-gap-calls/runs/comp-assessment`
- Records: 2 from ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-12-policy-gap-calls/records/comp-assessment.jsonl
- Reps: 2

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| job-compensation-assessment-batch haiku:high | 4 | 3 | 0 | $0.132 |  |
| job-compensation-assessment-batch haiku:medium | 4 | 4 | 0 | $0.100 |  |
| job-compensation-assessment-batch opus:low | 4 | 4 | 0 | $1.058 |  |
| job-compensation-assessment-batch sonnet:high | 4 | 4 | 0 | $0.906 |  |
| job-compensation-assessment-batch sonnet:low | 4 | 4 | 0 | $0.556 |  |
| job-compensation-assessment-batch sonnet:medium | 4 | 4 | 0 | $0.677 |  |

Recorded cost so far: $3.430.
<!-- /ai-test-run:2026-11-12T22-04-14-956Z-claude-effort-ladderrun-ed0dd9 -->

<!-- ai-test-run:2026-11-12T22-04-14-955Z-claude-effort-ladderrun-cf5090 -->
### 2026-11-12 22:04 UTC · claude-effort-ladder run · interview-answer-entailment · opus:high, haiku:high, sonnet:low, sonnet:medium, sonnet:high, opus:low, opus:medium

- Status: **finished** (updated 2026-11-12 22:15:05 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-12-policy-gap-calls/runs/qa-entailment`
- Command: `node scripts/claude-effort-ladder.mjs run --records ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-12-policy-gap-calls/records/qa-entailment.jsonl --configs opus:high,haiku:high,sonnet:low,sonnet:medium,sonnet:high,opus:low,opus:medium --reps 2 --concurrency 3 --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-12-policy-gap-calls/runs/qa-entailment`
- Records: 3 from ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-12-policy-gap-calls/records/qa-entailment.jsonl
- Reps: 2

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| interview-answer-entailment haiku:high | 6 | 6 | 0 | $0.049 |  |
| interview-answer-entailment opus:high | 6 | 6 | 0 | $0.913 |  |
| interview-answer-entailment opus:low | 6 | 6 | 0 | $0.772 |  |
| interview-answer-entailment opus:medium | 6 | 6 | 0 | $0.836 |  |
| interview-answer-entailment sonnet:high | 6 | 6 | 0 | $0.439 |  |
| interview-answer-entailment sonnet:low | 6 | 6 | 0 | $0.402 |  |
| interview-answer-entailment sonnet:medium | 6 | 6 | 0 | $0.415 |  |

Recorded cost so far: $3.827.
<!-- /ai-test-run:2026-11-12T22-04-14-955Z-claude-effort-ladderrun-cf5090 -->

<!-- ai-test-run:2026-11-12T22-07-32-389Z-claude-effort-ladderrun-6614aa -->
### 2026-11-12 22:07 UTC · claude-effort-ladder run · interview-qa-practice · opus:low, haiku:low, haiku:medium, sonnet:low, sonnet:medium

- Status: **finished** (updated 2026-11-12 22:07:46 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-12-policy-gap-calls/runs/qa-practice-order`
- Command: `node scripts/claude-effort-ladder.mjs run --records ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-12-policy-gap-calls/records/qa-practice-order.jsonl --configs opus:low,haiku:low,haiku:medium,sonnet:low,sonnet:medium --reps 2 --concurrency 3 --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-12-policy-gap-calls/runs/qa-practice-order`
- Records: 1 from ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-12-policy-gap-calls/records/qa-practice-order.jsonl
- Reps: 2

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| interview-qa-practice haiku:low | 2 | 2 | 0 | $0.002 |  |
| interview-qa-practice haiku:medium | 2 | 2 | 0 | $0.001 |  |
| interview-qa-practice opus:low | 2 | 2 | 0 | $0.028 |  |
| interview-qa-practice sonnet:low | 2 | 2 | 0 | $0.014 |  |
| interview-qa-practice sonnet:medium | 2 | 2 | 0 | $0.014 |  |

Recorded cost so far: $0.058.
<!-- /ai-test-run:2026-11-12T22-07-32-389Z-claude-effort-ladderrun-6614aa -->

<!-- ai-test-run:2026-11-12T22-07-46-313Z-claude-effort-ladderrun-fb802b -->
### 2026-11-12 22:07 UTC · claude-effort-ladder run · interview-qa-disclosures · opus:low, haiku:medium, haiku:high, sonnet:low, sonnet:medium

- Status: **finished** (updated 2026-11-12 22:08:46 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-12-policy-gap-calls/runs/qa-disclosures`
- Command: `node scripts/claude-effort-ladder.mjs run --records ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-12-policy-gap-calls/records/qa-disclosures.jsonl --configs opus:low,haiku:medium,haiku:high,sonnet:low,sonnet:medium --reps 2 --concurrency 3 --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-12-policy-gap-calls/runs/qa-disclosures`
- Records: 2 from ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-12-policy-gap-calls/records/qa-disclosures.jsonl
- Reps: 2

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| interview-qa-disclosures haiku:high | 4 | 4 | 0 | $0.008 |  |
| interview-qa-disclosures haiku:medium | 4 | 4 | 0 | $0.008 |  |
| interview-qa-disclosures opus:low | 4 | 4 | 0 | $0.159 |  |
| interview-qa-disclosures sonnet:low | 4 | 4 | 0 | $0.091 |  |
| interview-qa-disclosures sonnet:medium | 4 | 4 | 0 | $0.091 |  |

Recorded cost so far: $0.356.
<!-- /ai-test-run:2026-11-12T22-07-46-313Z-claude-effort-ladderrun-fb802b -->

<!-- ai-test-run:2026-11-12T22-16-25-033Z-claude-effort-ladderrun-b3e61e -->
### 2026-11-12 22:16 UTC · claude-effort-ladder run · job-role-snippet-screen-batch · haiku:low, haiku:medium, sonnet:medium

- Status: **finished** (updated 2026-11-12 22:17:47 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-12-policy-gap-calls/runs/snippet-screen`
- Command: `node scripts/claude-effort-ladder.mjs run --records ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-12-policy-gap-calls/records/snippet-screen.jsonl --configs haiku:low,haiku:medium,sonnet:medium --reps 2 --concurrency 3 --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-12-policy-gap-calls/runs/snippet-screen`
- Records: 4 from ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-12-policy-gap-calls/records/snippet-screen.jsonl
- Reps: 2

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| job-role-snippet-screen-batch haiku:low | 8 | 8 | 0 | $0.045 |  |
| job-role-snippet-screen-batch haiku:medium | 8 | 8 | 0 | $0.045 |  |
| job-role-snippet-screen-batch sonnet:medium | 8 | 8 | 0 | $0.430 |  |

Recorded cost so far: $0.520.
<!-- /ai-test-run:2026-11-12T22-16-25-033Z-claude-effort-ladderrun-b3e61e -->

<!-- ai-test-run:2026-11-12T22-17-47-305Z-claude-effort-ladderrun-ac7188 -->
### 2026-11-12 22:17 UTC · claude-effort-ladder run · job-gap-review · sonnet:high, haiku:medium, haiku:high

- Status: **finished** (updated 2026-11-12 22:18:33 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-12-policy-gap-calls/runs/gap-review`
- Command: `node scripts/claude-effort-ladder.mjs run --records ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-12-policy-gap-calls/records/gap-review.jsonl --configs sonnet:high,haiku:medium,haiku:high --reps 2 --concurrency 3 --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-12-policy-gap-calls/runs/gap-review`
- Records: 2 from ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-12-policy-gap-calls/records/gap-review.jsonl
- Reps: 2

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| job-gap-review haiku:high | 4 | 4 | 0 | $0.045 |  |
| job-gap-review haiku:medium | 4 | 3 | 0 | $0.043 |  |
| job-gap-review sonnet:high | 4 | 3 | 0 | $0.469 |  |

Recorded cost so far: $0.557.
<!-- /ai-test-run:2026-11-12T22-17-47-305Z-claude-effort-ladderrun-ac7188 -->

<!-- ai-test-run:2026-11-12T22-30-11-376Z-claude-effort-ladderrun-340017 -->
### 2026-11-12 22:30 UTC · claude-effort-ladder run · interview-answer-entailment · opus:high, opus:low, opus:medium, sonnet:high

- Status: **finished** (updated 2026-11-12 22:36:24 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-12-policy-gap-calls/runs/ent-plants`
- Command: `node scripts/claude-effort-ladder.mjs run --records ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-12-policy-gap-calls/records/ent-plants.jsonl --configs opus:high,opus:low,opus:medium,sonnet:high --reps 2 --concurrency 3 --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-12-policy-gap-calls/runs/ent-plants`
- Records: 3 from ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-12-policy-gap-calls/records/ent-plants.jsonl
- Reps: 2

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| interview-answer-entailment opus:high | 6 | 6 | 0 | $0.875 |  |
| interview-answer-entailment opus:low | 6 | 6 | 0 | $0.775 |  |
| interview-answer-entailment opus:medium | 6 | 6 | 0 | $0.814 |  |
| interview-answer-entailment sonnet:high | 6 | 6 | 0 | $0.430 |  |

Recorded cost so far: $2.895.
<!-- /ai-test-run:2026-11-12T22-30-11-376Z-claude-effort-ladderrun-340017 -->

<!-- ai-test-run:2026-11-12T22-30-11-376Z-claude-effort-ladderrun-13839d -->
### 2026-11-12 22:30 UTC · claude-effort-ladder run · job-gap-review · sonnet:high, haiku:medium, haiku:high

- Status: **finished** (updated 2026-11-12 22:31:26 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-12-policy-gap-calls/runs/gap-plants`
- Command: `node scripts/claude-effort-ladder.mjs run --records ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-12-policy-gap-calls/records/gap-plants.jsonl --configs sonnet:high,haiku:medium,haiku:high --reps 2 --concurrency 3 --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-12-policy-gap-calls/runs/gap-plants`
- Records: 4 from ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-12-policy-gap-calls/records/gap-plants.jsonl
- Reps: 2

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| job-gap-review haiku:high | 8 | 7 | 0 | $0.082 |  |
| job-gap-review haiku:medium | 8 | 7 | 0 | $0.081 |  |
| job-gap-review sonnet:high | 8 | 6 | 0 | $0.856 |  |

Recorded cost so far: $1.020.
<!-- /ai-test-run:2026-11-12T22-30-11-376Z-claude-effort-ladderrun-13839d -->

<!-- ai-test-run:2026-11-12T22-56-03-580Z-blindjudgeDeepSeekFlashOffloadreportjob-271f6a -->
### 2026-11-12 22:56 UTC · blind judge (DeepSeek Flash, Offload report job) · job-role-screen-batch, job-role-snippet-screen-batch · 2026-11-12 disputed rows

- Status: **finished** (updated 2026-11-12 22:56:03 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-12-policy-gap-calls`
- Items: 300 title rows sampled from 1,054 disputed; all 106 disputed snippet rows
- Judge job: oj-20261112-fb7ceb8972984ef394422bbc5270ea6e (review packet passed 10/10)

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| title haiku:low (2 reruns) | 600 |  |  |  | 60.7% right; 27 real jobs dropped; 151 mismatches kept; $0.036/call |
| title production haiku:low | 300 |  |  |  | 58.3% right; 34 real jobs dropped; 51 mismatches kept |
| title haiku:medium | 600 |  |  |  | 64.8% right; 32 real jobs dropped; 102 mismatches kept; $0.047/call |
| title sonnet:medium | 600 |  |  |  | 59.7% right; 158 real jobs dropped; 15 mismatches kept; $0.223/call |
| snippet haiku:low (2 reruns) | 212 |  |  |  | 58.5% right; 40 real jobs dropped; 48 mismatches kept; $0.0056/call |
| snippet production haiku:low | 106 |  |  |  | 53.8% right; 28 real jobs dropped; 21 mismatches kept |
| snippet haiku:medium | 212 |  |  |  | 65.1% right; 28 real jobs dropped; 46 mismatches kept; $0.0056/call |
| snippet sonnet:medium | 212 |  |  |  | 44.3% right; 118 real jobs dropped; 0 mismatches kept; $0.054/call |

Recorded cost so far: $0.000.
- Note: Disputed rows only (rows where any arm disagreed), so rates are far below whole-batch accuracy.
<!-- /ai-test-run:2026-11-12T22-56-03-580Z-blindjudgeDeepSeekFlashOffloadreportjob-271f6a -->

<!-- ai-test-run:2026-11-12T22-56-03-621Z-plantedpagesladderrunscoremjs-300591 -->
### 2026-11-12 22:56 UTC · planted pages (ladder run, score.mjs) · job-listing-liveness · 2026-11-12 planted closed/open/login pages

- Status: **finished** (updated 2026-11-12 22:56:03 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-12-policy-gap-calls`

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| haiku:low | 26 | 26 | 0 | $0.061 | real rows 6/8 match production; planted 15/20 (all 4 jsonld-only missed, 1 open-with-deadline as unclear) |
| haiku:medium | 26 | 26 | 0 | $0.063 | real 8/8; planted 16/20 (only the 4 jsonld-only missed) |
| sonnet:medium | 26 | 26 | 0 | $0.648 | real 7/8; planted 16/20 (only the 4 jsonld-only missed) |

Recorded cost so far: $0.772.
- Note: jsonld-only = JSON-LD isListed false with no closure text; every arm answered open or unclear (the prompt allows closed there but does not require it).
<!-- /ai-test-run:2026-11-12T22-56-03-621Z-plantedpagesladderrunscoremjs-300591 -->

<!-- ai-test-run:2026-11-12T22-56-03-659Z-planteddefectsladderrunscore-plantsmjs-767f0a -->
### 2026-11-12 22:56 UTC · planted defects (ladder run, score-plants.mjs) · job-gap-review · 2026-11-12 soft wording, overlooked evidence, duplicate row, near-miss trap

- Status: **finished** (updated 2026-11-12 22:56:03 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-12-policy-gap-calls`

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| sonnet:high (production) | 8 | 6 | 0 | $0.857 | caught 8/8; 0/18 false alarms |
| haiku:medium | 8 | 7 | 0 | $0.081 | caught 8/8; 0/18 false alarms |
| haiku:high | 8 | 7 | 0 | $0.082 | caught 8/8; 0/18 false alarms |

Recorded cost so far: $1.020.
- Note: Real prompts (2, every row confirmed): haiku:high 18/18 agreement, 4/4 valid; haiku:medium 15/18, 3/4 valid; sonnet:high rerun 17/18, 3/4 valid.
<!-- /ai-test-run:2026-11-12T22-56-03-659Z-planteddefectsladderrunscore-plantsmjs-767f0a -->

<!-- ai-test-run:2026-11-12T22-56-03-696Z-planteddefectsreal-flagagreement-8b985e -->
### 2026-11-12 22:56 UTC · planted defects + real-flag agreement · interview answer entailment review (stage qa-fact-check) · 2026-11-12

- Status: **finished** (updated 2026-11-12 22:56:03 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-12-policy-gap-calls`

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| opus:high (production) | 6 | 6 | 0 | $0.875 | real flags caught 4/4; planted 18/18; 0/178 false alarms |
| opus:medium | 6 | 6 | 0 | $0.814 | real flags 3/4; planted 18/18 |
| opus:low | 6 | 6 | 0 | $0.775 | real flags 3/4; planted 18/18; 1/178 false alarm |
| sonnet:high | 6 | 6 | 0 | $0.430 | real flags 1/4; planted 18/18 |
| haiku:high | 6 | 6 | 0 | $0.049 | real flags 1/4; 3 false alarms on real prompts |

Recorded cost so far: $2.943.
- Note: Production flagged 2 claims across 3 real prompts (4 instances over 2 reps); planted defects were coarse, so the real flags decide.
<!-- /ai-test-run:2026-11-12T22-56-03-696Z-planteddefectsreal-flagagreement-8b985e -->

<!-- ai-test-run:2026-11-12T22-56-03-735Z-appvalidatorblindjudgeDeepSeekFlash-c64004 -->
### 2026-11-12 22:56 UTC · app validator + blind judge (DeepSeek Flash) · job-compensation-assessment-batch · 2026-11-12 one real 4-cohort prompt

- Status: **finished** (updated 2026-11-12 22:56:03 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-12-policy-gap-calls`
- Validator: validateCompensationEvidenceBatchSubmission rebuilt from the prompt (comp-validate.mjs)
- Judge job: oj-20261112-2f5f235e70174a6ab52499665f43d209

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| production opus:low | 1 | 1 |  | $0.268 | judge 8 |
| opus:low reruns | 4 | 4 | 0 | $1.058 | judge 6, 5; agreement with production 87.6% |
| sonnet:low | 4 | 4 | 0 | $0.556 | judge 9, 8; agreement 70.0% |
| sonnet:medium | 4 | 4 | 0 | $0.677 | judge 9, 7; agreement 86.2% |
| sonnet:high | 4 | 4 | 0 | $0.906 | judge 8, 8; agreement 87.8% |
| haiku:medium | 4 | 4 | 0 | $0.100 | judge 6, 7; agreement 74.2% |
| haiku:high | 4 | 3 | 0 | $0.132 | agreement 67.1% |

Recorded cost so far: $3.697.
<!-- /ai-test-run:2026-11-12T22-56-03-735Z-appvalidatorblindjudgeDeepSeekFlash-c64004 -->

<!-- ai-test-run:2026-11-12T22-56-03-772Z-blindjudgeDeepSeekFlash-d7719c -->
### 2026-11-12 22:56 UTC · blind judge (DeepSeek Flash) · interview answer card repair (stage qa-fact-correction) · 2026-11-12 two real repair prompts

- Status: **finished** (updated 2026-11-12 22:56:03 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-12-policy-gap-calls`
- Judge jobs: oj-20261112-a4cd7f7535644641ae226c1064050e35, oj-20261112-fbb6ef1a37ec46d1b7b7e23649ddf8d3

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| production opus:high | 2 |  |  |  | judge 8, 9 |
| opus:high rerun | 4 | 4 | 0 | $2.021 | judge 9, 7 |
| opus:low | 4 | 4 | 0 | $1.340 | judge 9, 8; no unsupported claims |
| sonnet:high | 4 | 4 | 0 | $1.334 | judge 8, 8 |
| sonnet:medium | 4 | 4 | 0 | $0.878 | judge 7, 7; unsupported claims in both |
| haiku:high | 4 | 4 | 0 | $0.130 | judge 6, 6; broken sentences, spliced quotes |

Recorded cost so far: $5.703.
<!-- /ai-test-run:2026-11-12T22-56-03-772Z-blindjudgeDeepSeekFlash-d7719c -->

<!-- ai-test-run:2026-11-12T22-56-03-811Z-blindjudgeDeepSeekFlashagreement-121799 -->
### 2026-11-12 22:56 UTC · blind judge (DeepSeek Flash) + agreement · interview-qa-practice order, interview-qa-disclosures (stage qa-brief) · 2026-11-12

- Status: **finished** (updated 2026-11-12 22:56:03 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-12-policy-gap-calls`
- Practice judge job: oj-20261112-d73760090aaf415ba035c8e8b06e6ead

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| practice production opus:low | 1 |  |  |  | judge 9 |
| practice opus:low reruns | 2 | 2 | 0 | $0.028 | judge 10, 10; rank correlation 0.95 |
| practice sonnet:low | 2 | 2 | 0 | $0.014 | judge 7, 6 |
| practice sonnet:medium | 2 | 2 | 0 | $0.014 | judge 7, 7 |
| practice haiku:low | 2 | 1 | 0 | $0.002 | judge 8, 2 (one repeated a question) |
| practice haiku:medium | 2 | 2 | 0 | $0.001 | judge 8, 5 |
| disclosures opus:low rerun | 4 | 4 | 0 | $0.159 | agreement 100% (extraction + mapping prompts) |
| disclosures sonnet:low | 4 | 4 | 0 | $0.091 | agreement 100% |
| disclosures sonnet:medium | 4 | 4 | 0 | $0.090 | agreement 100% |
| disclosures haiku:medium | 4 | 4 | 0 | $0.008 | agreement 79% (extraction 25%, 100%) |
| disclosures haiku:high | 4 | 4 | 0 | $0.008 | agreement 75% (extraction 0%, 100%) |

Recorded cost so far: $0.415.
<!-- /ai-test-run:2026-11-12T22-56-03-811Z-blindjudgeDeepSeekFlashagreement-121799 -->

<!-- ai-test-run:2026-11-14-posting-parallel-vs-tavily -->
### 2026-11-14 · Parallel Search vs Tavily · official-posting research (30 confirmed postings, seed 2) · finished

- Status: **finished**. A first attempt on the default CLI login (contact@jackwu.ca) failed all 90 calls with CLAUDE_USAGE_LIMIT ($0, that account's weekly limit); the run below used the jacksterwu@gmail.com account through its CLAUDE_CONFIG_DIR.
- Out dirs: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-14-posting-parallel-vs-tavily-jacksterwu` (results.jsonl, summary.json, plain-leads-perjob.json) and `.../2026-11-14-posting-parallel-vs-tavily` (the failed first attempt, plain-leads-and-size.json)
- Command: `scripts/official-research-search-ab.mjs --canvas "Job Search/canvas.json.before-content-pool-2026-11-04.bak" --found 30 --missed 0 --seed 2 --concurrency 3 --arms native,tavily,parallel` (new `parallel` arm). One run, n=30.

| Arm | Valid | Exact posting | Right employer site | Avg s | Cost (30 lookups) | Search calls |
|---|---|---|---|---|---|---|
| native (built-in) | 30 | 18/30 | 25/30 | 22 | $5.10 ($0.170 each) | 41 WebSearch, 50 WebFetch |
| tavily | 30 | 23/30 | 26/30 | 10 | $4.57 ($0.152 each) | 37 search, 3 extract, 2 map |
| **parallel** | 30 | **28/30** | 28/30 | 10 | **$3.99 ($0.133 each)** | 30 search (one per job) |

Merged per job (any arm or plain search found the confirmed posting): built-in + Tavily 25; built-in + Parallel 28; **old pipeline** (built-in + Tavily + plain Tavily leads) **26**; **new pipeline** (built-in + Parallel + plain Parallel leads) **28**; all five sources 28. Parallel alone already gets 28, and nothing adds to it: the two misses (Capital One, Kinaxis) were missed by every source.

Plain (no-AI) leads, same jobs: Tavily 9 to 10/30 exact (two runs), Parallel 20/30; right site 17 vs 27.

Response size per search (6 queries): Tavily 7,740 chars basic-5, 20,137 advanced-10; Parallel 27,984. Despite the larger responses Parallel was the cheapest arm end to end, because Claude needed one search per job and no page reads.

Caveats: single run on one task. The Tavily and built-in numbers moved by 1 to 2 jobs against the 2026-11-08 run (21 and 17), so differences of 1 to 2 are noise; Parallel's 5-job lead over Tavily is larger than that. Salary, role-family and location research were not re-measured.

Recorded cost so far: $13.66 (native $5.10 + tavily $4.57 + parallel $3.99).
<!-- /ai-test-run:2026-11-14-posting-parallel-vs-tavily -->

<!-- ai-test-run:2026-11-14T13-59-59-351Z-web-research-ab-44119b -->
### 2026-11-14 13:59 UTC · web-research-ab · role-family · production profile

- Status: **finished** (updated 2026-11-14 14:04:44 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-14-role-family-parallel`
- Command: `node scripts/web-research-ab.mjs --task role-family --canvas ~/Desktop/Job Search/canvas.json.before-content-pool-2026-11-04.bak --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-14-role-family-parallel --second parallel --count 12 --seed 1 --concurrency 3`
- Count: 12
- Seed: 1
- summary roleFamilies: 54
- summary sampledRoleFamilies: 12
- summary batches: 6
- summary distinctSourceUrls: 72

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| research merged | 6 | 6 | 0 | $0.000 | outcome per arm: summary.json |
| research native | 6 | 1 | 5 | $1.109 | outcome per arm: summary.json |
| research tavily | 6 | 6 | 0 | $0.708 | outcome per arm: summary.json |

Recorded cost so far: $1.817.
<!-- /ai-test-run:2026-11-14T13-59-59-351Z-web-research-ab-44119b -->

<!-- ai-test-run:2026-11-14T14-04-44-719Z-web-research-ab-d532cd -->
### 2026-11-14 14:04 UTC · web-research-ab · location · production profile

- Status: **finished** (updated 2026-11-14 14:08:03 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-14-location-parallel`
- Command: `node scripts/web-research-ab.mjs --task location --canvas ~/Desktop/Job Search/canvas.json.before-content-pool-2026-11-04.bak --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-14-location-parallel --second parallel --count 24 --seed 1 --concurrency 3`
- Count: 24
- Seed: 1
- summary eligibleRows: 106
- summary skippedWithoutIdentity: 0
- summary requests: 24
- summary batches: 6

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| research native | 6 | 6 | 0 | $1.258 | outcome per arm: summary.json |
| research tavily | 6 | 6 | 0 | $0.967 | outcome per arm: summary.json |

Recorded cost so far: $2.226.
<!-- /ai-test-run:2026-11-14T14-04-44-719Z-web-research-ab-d532cd -->

<!-- ai-test-run:2026-11-14T14-08-03-406Z-web-research-ab-acbbf9 -->
### 2026-11-14 14:08 UTC · web-research-ab · compensation · production profile

- Status: **finished** (updated 2026-11-14 14:13:47 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-14-compensation-parallel`
- Command: `node scripts/web-research-ab.mjs --task compensation --canvas ~/Desktop/Job Search/canvas.json.before-content-pool-2026-11-04.bak --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-14-compensation-parallel --second parallel --count 12 --seed 3 --concurrency 3`
- Count: 12
- Seed: 3
- summary cohorts: 452
- summary sampledCohorts: 12
- summary batches: 6
- summary distinctSourceUrls: 25

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| research merged | 6 | 6 | 0 | $0.000 | outcome per arm: summary.json |
| research native | 6 | 3 | 3 | $1.480 | outcome per arm: summary.json |
| research tavily | 6 | 6 | 0 | $0.503 | outcome per arm: summary.json |

Recorded cost so far: $1.983.
<!-- /ai-test-run:2026-11-14T14-08-03-406Z-web-research-ab-acbbf9 -->

<!-- ai-test-run:2026-11-14-research-parallel-batch -->
### 2026-11-14 · Parallel Search as the second research toolset · role-family, location, salary · finished (salary confounded)

- Status: **finished**. Command: `scripts/web-research-ab.mjs --task <task> --second parallel --seed <n> --count <n>` on `canvas.json.before-content-pool-2026-11-04.bak`, the default Sonnet medium profile. New `--second parallel` option: the arm that the output files still label `tavily` ran Parallel Search; the `merged` arm is built-in + Parallel.
- Out dirs: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-14-{role-family,location,compensation}-parallel`, log `2026-11-14-research-parallel-batch.log`. One run each.

| Task | Built-in | Parallel | Merged |
|---|---|---|---|
| Role-family bands (12 families, seed 1): answered / with 2+ verified hosts / verified sources / cost | 2 / 1 / 3 / $1.11 (5 of 6 replies failed the format) | **12 / 11 / 52 / $0.71** | 12 / 12 / 56 |
| Job location (24 cards, seed 1): correct / wrong / not found / cost | 1 / 1 / 22 / $1.26 | 2 / 1 / 21 / $0.97 | 2 / 1 / 21 |
| Salary (12 cohorts, seed 3): sections with a verified source / verified sources | 3 / 7 | 1 / 1 | 3 / 8 |

- Role-family: Parallel answered every family with verified sources; the Tavily-era run (older profile) had built-in 4, Tavily 4, merged 8 families with 2+ hosts, but the profile differs, so only the direction compares.
- Location: all arms are low (the 2026-11-09 Opus-era run got 5 / 6 / 7 correct). The profile changed in between (Sonnet medium since 2026-11-09), so this is probably the profile and not Parallel; not verified. Parallel is no worse than built-in here.
- Salary is **not a valid measurement**: Parallel's replies in this run quote "You've hit the free-tier rate limit for Parallel MCP" (checked in sections.json and research-cache). My Parallel fetches of the 25 cited pages for a fair rescoring all failed for the same reason. Rerun after the limit clears or with an API key.
- The free anonymous endpoint DID hit a rate limit after about 170 calls in under three hours (searches, fetches, the 30-job posting test and these three runs, concurrency 3): JSON-RPC error code -32000, HTTP 200. The app now stops calling Parallel for ten minutes on that signal and says so in the dock; an optional key (Keychain item `infinite-canvas-parallel-api-key`) raises the limits.

Recorded cost so far: $6.03 (role-family $1.82, location $2.23, salary $1.98 across the built-in and Parallel arms).
<!-- /ai-test-run:2026-11-14-research-parallel-batch -->

<!-- ai-test-run:2026-11-14T23-19-41-046Z-web-research-ab-594d2b -->
### 2026-11-14 23:19 UTC · web-research-ab · compensation · production profile

- Status: **interrupted (SIGTERM) before finishing; rows above are complete up to that point** (updated 2026-11-14 23:21:57 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-14-compensation-parallel-keyed`
- Command: `node scripts/web-research-ab.mjs --task compensation --canvas ~/Desktop/Job Search/canvas.json.before-content-pool-2026-11-04.bak --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-14-compensation-parallel-keyed --second parallel --count 12 --seed 3 --concurrency 3`
- Count: 12
- Seed: 3

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| research merged | 2 | 2 | 0 | $0.000 | outcome per arm: summary.json |
| research native | 2 | 0 | 2 | $0.344 | outcome per arm: summary.json |
| research tavily | 3 | 3 | 0 | $0.417 | outcome per arm: summary.json |

Recorded cost so far: $0.761.
<!-- /ai-test-run:2026-11-14T23-19-41-046Z-web-research-ab-594d2b -->

<!-- ai-test-run:2026-11-14T23-24-10-872Z-web-research-ab-1b5f47 -->
### 2026-11-14 23:24 UTC · web-research-ab · compensation · production profile

- Status: **interrupted (SIGTERM) before finishing; rows above are complete up to that point** (updated 2026-11-14 23:24:20 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-14-compensation-parallel-mcp2`
- Command: `node scripts/web-research-ab.mjs --task compensation --canvas ~/Desktop/Job Search/canvas.json.before-content-pool-2026-11-04.bak --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-14-compensation-parallel-mcp2 --second parallel --count 12 --seed 3 --concurrency 3`
- Count: 12
- Seed: 3

No results yet.
<!-- /ai-test-run:2026-11-14T23-24-10-872Z-web-research-ab-1b5f47 -->

<!-- ai-test-run:2026-11-14T23-24-27-648Z-web-research-ab-da0273 -->
### 2026-11-14 23:24 UTC · web-research-ab · compensation · production profile

- Status: **finished** (updated 2026-11-14 23:29:11 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-14-compensation-parallel-keyed2`
- Command: `node scripts/web-research-ab.mjs --task compensation --canvas ~/Desktop/Job Search/canvas.json.before-content-pool-2026-11-04.bak --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-14-compensation-parallel-keyed2 --second parallel --count 12 --seed 3 --concurrency 3`
- Count: 12
- Seed: 3
- summary cohorts: 452
- summary sampledCohorts: 12
- summary batches: 6
- summary distinctSourceUrls: 83

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| research merged | 6 | 6 | 0 | $0.000 | outcome per arm: summary.json |
| research native | 6 | 2 | 4 | $0.955 | outcome per arm: summary.json |
| research tavily | 6 | 6 | 0 | $1.194 | outcome per arm: summary.json |

Recorded cost so far: $2.149.
<!-- /ai-test-run:2026-11-14T23-24-27-648Z-web-research-ab-da0273 -->

## 2026-11-14 Salary (compensation) research, Parallel with a valid API key (rerun)

- Status: **finished**. Command: `node scripts/web-research-ab.mjs --task compensation --second parallel --seed 3 --count 12 --concurrency 3` on `canvas.json.before-content-pool-2026-11-04.bak`, Sonnet medium. The arm the files label `tavily` ran Parallel on `mcp.parallel.ai/mcp` with the Keychain key (Bearer). Output: `ai-test-runs/2026-11-14-compensation-parallel-keyed2/`.
- Replaces the invalid earlier salary run (free-tier limit hit). No reply quoted a rate limit or an invalid key.
- 12 cohorts, 6 calls per arm. Sections with at least one verified source: built-in 4/12 (4 of 6 replies failed the section format), **Parallel 12/12**; verified sources 11 vs 26; research cost $0.955 vs $1.19 (the merged arm is two replies, not charged separately). The earlier two-or-more-host measure was not recomputed here.
- A first attempt used a Keychain value that was not a key (a pasted sentence) and was stopped; its output was deleted.

<!-- ai-test-run:2026-11-14T23-51-30-946Z-web-research-ab-abe8f6 -->
### 2026-11-14 23:51 UTC · web-research-ab · preference · production profile

- Status: **finished** (updated 2026-11-15 00:12:24 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-14-preference-parallel`
- Command: `node scripts/web-research-ab.mjs --task preference --canvas ~/Desktop/Job Search/canvas.json.before-content-pool-2026-11-04.bak --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-14-preference-parallel --second parallel --count 40 --seed 3 --concurrency 3`
- Count: 40
- Seed: 3
- summary disagreements: 120

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| research merged | 2 | 2 | 0 | $0.000 | outcome per arm: summary.json |
| research native | 4 | 3 | 1 | $10.71 | outcome per arm: summary.json |
| research tavily | 4 | 2 | 2 | $14.81 | outcome per arm: summary.json |

Recorded cost so far: $25.52.
<!-- /ai-test-run:2026-11-14T23-51-30-946Z-web-research-ab-abe8f6 -->

<!-- ai-test-run:2026-11-15T00-12-24-824Z-web-research-ab-11e826 -->
### 2026-11-15 00:12 UTC · web-research-ab · role-family · production profile

- Status: **finished** (updated 2026-11-15 00:16:17 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-14-role-family-parallel-seed2`
- Command: `node scripts/web-research-ab.mjs --task role-family --canvas ~/Desktop/Job Search/canvas.json.before-content-pool-2026-11-04.bak --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-14-role-family-parallel-seed2 --second parallel --count 12 --seed 2 --concurrency 3`
- Count: 12
- Seed: 2
- summary roleFamilies: 54
- summary sampledRoleFamilies: 12
- summary batches: 6
- summary distinctSourceUrls: 52

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| research merged | 6 | 6 | 0 | $0.000 | outcome per arm: summary.json |
| research native | 6 | 3 | 3 | $0.843 | outcome per arm: summary.json |
| research tavily | 6 | 6 | 0 | $0.743 | outcome per arm: summary.json |

Recorded cost so far: $1.586.
<!-- /ai-test-run:2026-11-15T00-12-24-824Z-web-research-ab-11e826 -->

<!-- ai-test-run:2026-11-15T00-16-17-359Z-web-research-ab-82d7cf -->
### 2026-11-15 00:16 UTC · web-research-ab · compensation · production profile

- Status: **finished** (updated 2026-11-15 00:22:20 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-14-compensation-parallel-seed4`
- Command: `node scripts/web-research-ab.mjs --task compensation --canvas ~/Desktop/Job Search/canvas.json.before-content-pool-2026-11-04.bak --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-14-compensation-parallel-seed4 --second parallel --count 12 --seed 4 --concurrency 3`
- Count: 12
- Seed: 4
- summary cohorts: 452
- summary sampledCohorts: 12
- summary batches: 6
- summary distinctSourceUrls: 48

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| research merged | 6 | 5 | 1 | $0.000 | outcome per arm: summary.json |
| research native | 6 | 2 | 4 | $1.007 | outcome per arm: summary.json |
| research tavily | 6 | 5 | 1 | $1.055 | outcome per arm: summary.json |

Recorded cost so far: $2.062.
<!-- /ai-test-run:2026-11-15T00-16-17-359Z-web-research-ab-82d7cf -->

<!-- ai-test-run:2026-11-15T00-22-20-416Z-web-research-ab-d1e8f2 -->
### 2026-11-15 00:22 UTC · web-research-ab · location · production profile

- Status: **finished** (updated 2026-11-15 00:25:31 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-14-location-parallel-seed2`
- Command: `node scripts/web-research-ab.mjs --task location --canvas ~/Desktop/Job Search/canvas.json.before-content-pool-2026-11-04.bak --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-14-location-parallel-seed2 --second parallel --count 24 --seed 2 --concurrency 3`
- Count: 24
- Seed: 2
- summary eligibleRows: 106
- summary skippedWithoutIdentity: 0
- summary requests: 24
- summary batches: 6

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| research native | 6 | 6 | 0 | $1.224 | outcome per arm: summary.json |
| research tavily | 6 | 6 | 0 | $1.235 | outcome per arm: summary.json |

Recorded cost so far: $2.459.
<!-- /ai-test-run:2026-11-15T00-22-20-416Z-web-research-ab-d1e8f2 -->

<!-- ai-test-run:2026-11-14-search-source-decision -->
### 2026-11-14 · Built-in search vs Parallel vs both, every AI call that uses the web · finished

- Status: **finished**. Question: per call, keep Claude's built-in web search, use Parallel Search, or run both and merge. Parallel ran with the Keychain API key on `mcp.parallel.ai/mcp`; no reply quoted a rate limit.
- Out dirs under `~/Library/Application Support/infinite-canvas/ai-test-runs/`: `2026-11-14-preference-parallel`, `2026-11-14-role-family-parallel-seed2`, `2026-11-14-compensation-parallel-seed4`, `2026-11-14-location-parallel-seed2`, `2026-11-14-posting-parallel-seed3`, `2026-11-14-interview-research-parallel` (log `2026-11-14-parallel-round2.log`). The arm the files label `tavily` ran Parallel (`--second parallel`).
- Commands: `scripts/web-research-ab.mjs --task <preference|role-family|compensation|location> --second parallel --seed <n> --count <n> --concurrency 3`; `scripts/official-research-search-ab.mjs --found 30 --missed 0 --seed 3 --arms native,parallel`; `scripts/interview-live-prepare-harness.mjs --research native|parallel|merged --merge-second parallel --stop-after brief` (new `parallel` arm), all on `canvas.json.before-content-pool-2026-11-04.bak` and the four Applied Jobs bundles used on 2026-11-09 (Appian, Intouch Insight, Reddit, Stripe).

| Call | Measure | Built-in | Parallel | Both merged | Research cost built-in / Parallel |
|---|---|---|---|---|---|
| Official-posting research, seed 2 (earlier today) | exact posting of 30 | 18 | 28 | 28 | $5.10 / $3.99 |
| Official-posting research, seed 3 | exact posting of 30 | 18 | 27 | 28 | $5.39 / $5.32 |
| Experience bands, seed 1 (earlier today) | families of 12 with two verified hosts | 1 | 11 | 12 | $1.11 / $0.71 |
| Experience bands, seed 2 | same | 4 | 10 | 12 | $0.84 / $0.74 |
| Salary, seed 3 keyed (earlier today) | cohorts of 12 with a verified source | 4 | 12 | not recomputed | $0.96 / $1.19 |
| Salary, seed 4 | same | 4 | 9 | 9 | $1.01 / $1.06 |
| Job location, seed 1 (earlier today) | correct / wrong of 24 | 1 / 1 | 2 / 1 | 2 / 1 | $1.26 / $0.97 |
| Job location, seed 2 | correct / wrong of 24 | 4 / 1 | 9 / 0 | 8 / 1 | $1.22 / $1.23 |
| Interview research (qa-research, Opus high), 4 jobs | blind Opus judge of the brief, 1 to 5, two passes | 3.43 | 4.05 | 3.85 | $0.48 / $0.77 per job |
| Preference (company) research, 40 companies, 180 checks | confirmed / conflicts / unverified | 38 / 0 / 142 | 37 / 1 / 142 | 174 / 2 / 4 | $10.71 / $14.81 |

- Built-in replies failed the section format often on Sonnet medium (experience bands 3 of 6, salary 4 of 6); Parallel 0 of 6 and 1 of 6.
- Interview research per job (mean of two judge passes; built-in / Parallel / merged): Appian 4.25 / 3.45 / 3.35, Intouch 2.8 / 4.3 / 3.85, Reddit 3.3 / 4.1 / 4.35, Stripe 3.35 / 4.35 / 3.85. Judge passes differed by at most 0.4. n=4, so this is a direction, not proof.
- Preference research is **not a clean comparison**: the 121-section batch failed the reply format in 1 of 2 built-in calls and 2 of 2 Parallel calls, so each single arm left 142 checks unverified; the merged figure is mostly the one valid built-in reply. Parallel cost more and never produced a valid large batch.
- Official-posting match was not run: it judges supplied page text and its web tools are almost never used (2026-11-08).

**Decision (owner, 2026-11-14, applied):** every web-using call runs **Parallel Search only**, decided on result quality alone. Claude is never offered built-in WebSearch or WebFetch and there is no fallback; an exhausted Parallel pauses web research with queued work kept (`PARALLEL_SEARCH_EXHAUSTED`). Applies to official-posting research (plus plain Parallel leads), salary, experience bands, job location, preference research, official-posting match and interview research. Claude gets six Parallel tools (`web_search`, `web_fetch`, `web_decisions`, `find_verticals`, `search_vertical`, `image_search`; not `send_feedback`).

- Preference rerun (same command; the failed large batches answered this time, stopped before the merged step): 172 checks answered by both arms, built-in 166 confirmed / 2 conflicts / 4 unverified, Parallel 158 / 2 / 12. Same two conflicts. First-pass copy: `2026-11-14-preference-parallel-first-pass`.

Recorded cost so far: about $48 (preference $25.5 plus assessments $0.8, experience bands $1.6, salary $2.1, location $2.5, posting $10.7, interview research and briefs $6.4, judging not recorded).
<!-- /ai-test-run:2026-11-14-search-source-decision -->

<!-- ai-test-run:2026-11-15T00-51-35-864Z-web-research-ab-1ab55e -->
### 2026-11-15 00:51 UTC · web-research-ab · preference · production profile

- Status: **interrupted (SIGTERM) before finishing; rows above are complete up to that point** (updated 2026-11-15 01:13:39 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-14-preference-parallel`
- Command: `node scripts/web-research-ab.mjs --task preference --canvas ~/Desktop/Job Search/canvas.json.before-content-pool-2026-11-04.bak --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-14-preference-parallel --second parallel --count 40 --seed 3 --concurrency 3`
- Count: 40
- Seed: 3

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| research native | 2 | 2 | 0 | $6.377 | outcome per arm: summary.json |
| research tavily | 2 | 2 | 0 | $9.076 | outcome per arm: summary.json |

Recorded cost so far: $15.45.
<!-- /ai-test-run:2026-11-15T00-51-35-864Z-web-research-ab-1ab55e -->

<!-- ai-test-run:2026-11-15T01-43-10-506Z-web-research-ab-f5fd1b -->
### 2026-11-15 01:43 UTC · web-research-ab · location · production profile

- Status: **finished** (updated 2026-11-15 01:43:54 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-14-location-parallel-six-tools`
- Command: `node scripts/web-research-ab.mjs --task location --canvas ~/Desktop/Job Search/canvas.json.before-content-pool-2026-11-04.bak --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-14-location-parallel-six-tools --second parallel --count 8 --seed 2 --concurrency 2`
- Count: 8
- Seed: 2
- summary eligibleRows: 106
- summary skippedWithoutIdentity: 0
- summary requests: 8
- summary batches: 2

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| research native | 2 | 0 | 2 | $0.033 | outcome per arm: summary.json |
| research tavily | 2 | 2 | 0 | $0.632 | outcome per arm: summary.json |

Recorded cost so far: $0.666.
<!-- /ai-test-run:2026-11-15T01-43-10-506Z-web-research-ab-f5fd1b -->

<!-- ai-test-run:2026-11-15T02-29-59-116Z-ai-task-replay-757b9d -->
### 2026-11-15 02:29 UTC · ai-task-replay · job-official-posting-match · claude, claude-native, claude-parallel

- Status: **finished** (updated 2026-11-15 02:36:33 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-14-posting-match-search`
- Command: `node scripts/ai-task-replay.mjs --task job-official-posting-match --canvas ~/Desktop/Job Search/canvas.json.before-content-pool-2026-11-04.bak --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-14-posting-match-search --configs claude,claude-native,claude-parallel --batches 16 --claude-reps 1 --reps 2 --concurrency 4`

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| claude | 16 | 16 | 0 | $2.973 | agreement: run ai-task-replay-score.mjs --out <dir> |
| claude-native | 32 | 32 | 0 | $6.705 | agreement: run ai-task-replay-score.mjs --out <dir> |
| claude-parallel | 32 | 30 | 0 | $5.934 | agreement: run ai-task-replay-score.mjs --out <dir> |

Recorded cost so far: $15.61.
<!-- /ai-test-run:2026-11-15T02-29-59-116Z-ai-task-replay-757b9d -->

<!-- ai-test-run:2026-11-14-posting-match-search -->
### 2026-11-14 · Built-in search vs Parallel · official-posting match (16 batches) · finished

- Status: **finished**. Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-14-posting-match-search` (log beside it).
- Command: `node --import ./scripts/test-stubs/register.mjs scripts/ai-task-replay.mjs --task job-official-posting-match --canvas "Job Search/canvas.json.before-content-pool-2026-11-04.bak" --configs claude,claude-native,claude-parallel --batches 16 --claude-reps 1 --reps 2 --concurrency 4` (new `claude-native` and `claude-parallel` configs; the `claude` baseline now runs Parallel like the app). Sonnet medium. Parallel ran with two tools in effect (`web_search`, `web_fetch` were the only ones called).

| Search | Calls | Valid | Mean cost | Tool calls | Same posting chosen, pairs of runs of the same search |
|---|---|---|---|---|---|
| Parallel (baseline + 2 reps) | 48 | 46 (95.8%) | $0.186 | 51 search, 57 fetch | 37 of 44 (84%) |
| Built-in (2 reps) | 32 | 32 (100%) | $0.210 | 48 search, 99 fetch | 15 of 16 (94%) |

- Across searches the same posting was chosen in 71 of 92 pairs (77%). Against the majority answer of the five runs per batch: built-in 30 of 32, Parallel 36 of 46. Status "open" was reported in 18 of 46 Parallel answers and 9 of 32 built-in answers.
- No ground truth was scored, so this measures consistency and validity, not correctness. Built-in was more consistent with itself. Every call used web tools in this replay (pages are downloaded without rendering here), unlike the 2026-11-08 finding that tools were rarely needed in production.
- No merged arm: the call returns one judgment per lead.
- Decision: first kept on Parallel only by the owner rule (2026-11-14). Changed 2026-11-15: the owner moved this one call back to built-in search at Sonnet medium, after the consistency gap here and the finding that Parallel's fetch can return old copies of removed postings.

Recorded cost so far: about $15.6 (Parallel $8.9, built-in $6.7).
<!-- /ai-test-run:2026-11-14-posting-match-search -->

<!-- ai-test-run:2026-11-15T03-45-41-550Z-web-research-ab-f37a38 -->
### 2026-11-15 03:45 UTC · web-research-ab · compensation · production profile

- Status: **stopped (process exited with code 0) before finishing** (updated 2026-11-15 03:46:37 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-14-compensation-task-core`
- Command: `node scripts/web-research-ab.mjs --task compensation --canvas ~/Desktop/Job Search/canvas.json.before-content-pool-2026-11-04.bak --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-14-compensation-task-core --second task --task-processor core --count 12 --seed 4 --concurrency 3`
- Count: 12
- Seed: 4
- Second: task
- Task processor: core

No results yet.
<!-- /ai-test-run:2026-11-15T03-45-41-550Z-web-research-ab-f37a38 -->

<!-- ai-test-run:2026-11-15T03-45-42-222Z-parallel-extract-ab-3a4d1e -->
### 2026-11-15 03:45 UTC · parallel-extract-ab · official posting page reading · app,parallel-live,parallel-default

- Status: **finished** (updated 2026-11-15 03:46:24 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-14-parallel-extract`
- Command: `--canvas ~/Desktop/Job Search/canvas.json.before-content-pool-2026-11-04.bak --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-14-parallel-extract --count 40 --seed 1`
- canvas: canvas.json.before-content-pool-2026-11-04.bak
- count: 40
- seed: 1
- concurrency: 4
- arms: app,parallel-live,parallel-default
- selected: 40

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| app | 40 | 25 | 8 |  | titleHit 26; median 4164 chars / 259 ms; closedSignal 0 |
| parallel-live | 40 | 35 | 0 |  | titleHit 35; median 6796 chars / 3032 ms; closedSignal 0 |
| parallel-default | 40 | 35 | 0 |  | titleHit 35; median 7209 chars / 555 ms; closedSignal 0 |

Recorded cost so far: $0.000.
<!-- /ai-test-run:2026-11-15T03-45-42-222Z-parallel-extract-ab-3a4d1e -->

<!-- ai-test-run:2026-11-15T03-46-24-721Z-parallel-decisions-ab-a19157 -->
### 2026-11-15 03:46 UTC · parallel-decisions-ab · job-preference-checks · min-prob 0.6

- Status: **finished** (updated 2026-11-15 03:46:43 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-14-parallel-decisions`
- Command: `node scripts/parallel-decisions-ab.mjs --results ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-14-preference-parallel/results.jsonl --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-14-parallel-decisions`
- Companies: 40
- Checks: 172
- Done: 40
- Failed: 0
- Requests: 40
- Compared: 172

No results yet.
<!-- /ai-test-run:2026-11-15T03-46-24-721Z-parallel-decisions-ab-a19157 -->

<!-- ai-test-run:2026-11-15T03-46-38-052Z-web-research-ab-4a79ae -->
### 2026-11-15 03:46 UTC · web-research-ab · role-family · production profile

- Status: **stopped (process exited with code 0) before finishing** (updated 2026-11-15 03:47:34 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-14-role-family-task-core`
- Command: `node scripts/web-research-ab.mjs --task role-family --canvas ~/Desktop/Job Search/canvas.json.before-content-pool-2026-11-04.bak --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-14-role-family-task-core --second task --task-processor core --count 12 --seed 2 --concurrency 3`
- Count: 12
- Seed: 2
- Second: task
- Task processor: core

No results yet.
<!-- /ai-test-run:2026-11-15T03-46-38-052Z-web-research-ab-4a79ae -->

<!-- ai-test-run:2026-11-15T03-47-34-348Z-web-research-ab-0b3a05 -->
### 2026-11-15 03:47 UTC · web-research-ab · location · production profile

- Status: **stopped (process exited with code 0) before finishing** (updated 2026-11-15 03:48:30 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-14-location-task-core`
- Command: `node scripts/web-research-ab.mjs --task location --canvas ~/Desktop/Job Search/canvas.json.before-content-pool-2026-11-04.bak --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-14-location-task-core --second task --task-processor core --count 24 --seed 2 --concurrency 3`
- Count: 24
- Seed: 2
- Second: task
- Task processor: core

No results yet.
<!-- /ai-test-run:2026-11-15T03-47-34-348Z-web-research-ab-0b3a05 -->

<!-- ai-test-run:2026-11-15T03-48-59-332Z-web-research-ab-d7a223 -->
### 2026-11-15 03:48 UTC · web-research-ab · compensation · production profile

- Status: **finished** (updated 2026-11-15 04:04:06 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-14-compensation-task-core`
- Command: `node scripts/web-research-ab.mjs --task compensation --canvas ~/Desktop/Job Search/canvas.json.before-content-pool-2026-11-04.bak --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-14-compensation-task-core --second task --task-processor core --count 12 --seed 4 --concurrency 3`
- Count: 12
- Seed: 4
- Second: task
- Task processor: core
- summary cohorts: 452
- summary sampledCohorts: 12
- summary batches: 6
- summary distinctSourceUrls: 42

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| research merged | 6 | 6 | 0 | $0.000 | outcome per arm: summary.json |
| research native | 6 | 2 | 4 | $1.080 | outcome per arm: summary.json |
| research tavily (parallel-task core) | 6 | 6 | 0 | $0.000 | outcome per arm: summary.json |

Recorded cost so far: $1.080.
<!-- /ai-test-run:2026-11-15T03-48-59-332Z-web-research-ab-d7a223 -->

<!-- ai-test-run:2026-11-15T04-04-06-710Z-web-research-ab-a51273 -->
### 2026-11-15 04:04 UTC · web-research-ab · role-family · production profile

- Status: **finished** (updated 2026-11-15 04:17:23 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-14-role-family-task-core`
- Command: `node scripts/web-research-ab.mjs --task role-family --canvas ~/Desktop/Job Search/canvas.json.before-content-pool-2026-11-04.bak --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-14-role-family-task-core --second task --task-processor core --count 12 --seed 2 --concurrency 3`
- Count: 12
- Seed: 2
- Second: task
- Task processor: core
- summary roleFamilies: 54
- summary sampledRoleFamilies: 12
- summary batches: 6
- summary distinctSourceUrls: 37

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| research merged | 6 | 6 | 0 | $0.000 | outcome per arm: summary.json |
| research native | 6 | 2 | 4 | $0.855 | outcome per arm: summary.json |
| research tavily (parallel-task core) | 6 | 6 | 0 | $0.000 | outcome per arm: summary.json |

Recorded cost so far: $0.855.
<!-- /ai-test-run:2026-11-15T04-04-06-710Z-web-research-ab-a51273 -->

<!-- ai-test-run:2026-11-15T04-17-23-390Z-web-research-ab-743be9 -->
### 2026-11-15 04:17 UTC · web-research-ab · location · production profile

- Status: **finished** (updated 2026-11-15 04:23:49 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-14-location-task-core`
- Command: `node scripts/web-research-ab.mjs --task location --canvas ~/Desktop/Job Search/canvas.json.before-content-pool-2026-11-04.bak --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-14-location-task-core --second task --task-processor core --count 24 --seed 2 --concurrency 3`
- Count: 24
- Seed: 2
- Second: task
- Task processor: core
- summary eligibleRows: 106
- summary skippedWithoutIdentity: 0
- summary requests: 24
- summary batches: 6

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| research native | 6 | 6 | 0 | $1.084 | outcome per arm: summary.json |
| research tavily (parallel-task core) | 6 | 6 | 0 | $0.000 | outcome per arm: summary.json |

Recorded cost so far: $1.084.
<!-- /ai-test-run:2026-11-15T04-17-23-390Z-web-research-ab-743be9 -->

<!-- ai-test-run:2026-11-14-parallel-features -->
### 2026-11-14 · Other Parallel features against what the app does today · finished (report only, nothing applied)

- Status: **finished**. Question: since the app now depends on Parallel, do its page reader (Extract), typed answers (Decisions) or research agent (Task) do an existing job better? Keyed account. Out dirs under `~/Library/Application Support/infinite-canvas/ai-test-runs/`: `2026-11-14-parallel-extract`, `2026-11-14-parallel-decisions`, `2026-11-14-{compensation,role-family,location}-task-core`.

**1. Page reader** — `scripts/parallel-extract-ab.mjs --count 40 --seed 1` (new). 40 confirmed official posting URLs from `canvas.json.before-content-pool-2026-11-04.bak`. "Usable" = read, 600+ characters and the job title's words present.

| Reader | Read | Usable | Median chars | Median time |
|---|---|---|---|---|
| App plain download (`fetchOfficialPosting`, no browser render) | 32 | 25 | 4,164 | 0.26 s |
| Parallel Extract, live (`max_age_seconds: 600`) | 40 | 35 | 6,796 | 3.0 s |
| Parallel Extract, default fetch policy | 40 | 35 | 7,209 | 0.56 s |

Usable only through Parallel: 12 pages; only through the app: 2. Live and default agreed on every page. No page showed a closed-posting signal in any arm, so freshness of the default (possibly cached) mode was not exercised. The app's hidden-browser render step was not part of this test (it needs Electron), so this compares Parallel with the first download step only.

**2. Decisions** — `scripts/parallel-decisions-ab.mjs --results 2026-11-14-preference-parallel/results.jsonl` (new). The 172 preference checks (40 companies) already answered by two Claude research runs; one Decisions request per company, choice questions excluded / not_excluded / unknown, probability floor 0.6. 40 requests, 0 failed, median 2.0 s.

| Source | Confirmed | Conflicts | Unverified |
|---|---|---|---|
| Decisions | 164 | 4 | 4 |
| Claude, built-in search | 166 | 2 | 4 |
| Claude, Parallel search | 158 | 2 | 12 |

Agreement: Decisions vs built-in 162 of 172, Decisions vs Claude-Parallel 156, the two Claude runs with each other 162. Decisions found both conflicts the Claude runs found (deCircle). Its two extra conflicts (Black Diamond Group, Envisio) were cleared by both Claude runs, came at probability 0.64, and one cites a similarly named staffing site; they look wrong. Its evidence leaned on job-board pages.

**3. Task research agent** — `scripts/web-research-ab.mjs --second task --task-processor core` (new arm; no Claude call, the Task run answers the same prompt), same seeds as the Claude-with-Parallel runs earlier today.

| Task | Claude + Parallel search (earlier today) | Parallel Task `core` |
|---|---|---|
| Salary, seed 4: cohorts of 12 with a verified source / verified sources | 9 / 20 | 5 / 8 |
| Experience bands, seed 2: families of 12 with two verified hosts / verified sources | 10 / 45 | 2 / 7 |
| Job location, seed 2: correct / wrong of 24 | 9 / 0 | 6 / 1 |

All 18 Task replies passed the format. Each took 47 to 228 s (Claude with Parallel: about 21 to 34 s). Only the `core` processor was tried.

Reading: the page reader is clearly better than the plain download; Decisions matches Claude on agreement but produced two likely false exclusions; the Task agent is worse than Claude with Parallel search on all three tasks.

Recorded cost so far: Parallel usage only (not metered here), plus the built-in comparison arms of the three Task runs (Claude, about $3).
<!-- /ai-test-run:2026-11-14-parallel-features -->

<!-- ai-test-run:2026-11-15T05-05-02-269Z-parallel-render-ab-612278 -->
### 2026-11-15 05:05 UTC · parallel-render-ab · hidden-browser render vs Parallel page reader · render,parallel

- Status: **finished** (updated 2026-11-15 05:10:08 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-render-vs-parallel`
- Command: `--canvas ~/Desktop/Job Search/canvas.json.before-content-pool-2026-11-04.bak --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-render-vs-parallel --closed 20 --open 20 --seed 1`
- canvas: canvas.json.before-content-pool-2026-11-04.bak
- closed: 20
- open: 20
- seed: 1
- completed: 40
- total: 40
- selected: 40
- records: 80

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| closed/render | 20 | 8 | 0 |  | closedDetected 8; median 4709 chars / 3082 ms |
| closed/parallel | 20 | 11 | 1 |  | closedDetected 3; median 7686 chars / 6168 ms |
| open/render | 20 | 17 | 0 |  | closedDetected 3; median 4473 chars / 2437 ms |
| open/parallel | 20 | 17 | 0 |  | closedDetected 0; median 5189 chars / 4077 ms |

Recorded cost so far: $0.000.
<!-- /ai-test-run:2026-11-15T05-05-02-269Z-parallel-render-ab-612278 -->

<!-- ai-test-run:2026-11-15-render-vs-parallel -->
### 2026-11-15 · App hidden-browser render vs Parallel page reader · official posting pages · finished (nothing applied)

- Status: **finished**. Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-render-vs-parallel` (log beside it).
- Command: `node_modules/.bin/electron scripts/parallel-render-ab.electron.mjs --canvas "Job Search/canvas.json.before-content-pool-2026-11-04.bak" --closed 20 --open 20 --seed 1` (new; runs the real `renderOfficialPostingPage` in Electron with a throwaway profile, then Parallel Extract with `full_content` and `fetch_policy.max_age_seconds: 600` on the same URL). 20 postings stored as closed, 20 stored as found (open on 2026-11-04).

| Group | Reader | Read | Usable (600+ chars, title present) | Closed detected by the script's wording check |
|---|---|---|---|---|
| Stored closed (20) | Render | 20 | 8 | 8 |
| Stored closed (20) | Parallel | 19 | 11 | 3 |
| Stored open (20) | Render | 20 | 17 | 3 |
| Stored open (20) | Parallel | 20 | 17 | 0 |

- Closed detected by the render only: 5 (stored closed) and 3 (stored open); by Parallel only: 0.
- Read by hand, the disagreements are real. On 5 pages the render got HTTP 404 or 410 while Parallel returned the full posting from an older copy (Amazon acquired 2026-10-20, Oshkosh 2026-11-02, Truist 2026-11-01, Brex 2026-09-14, one Ashby posting 2026-10-22), even though a 10-minute maximum age was requested: when the live fetch fails Parallel falls back to its stored copy. On 3 Greenhouse pages fetched the same day, Parallel's text left out the sentence "The job you are looking for is no longer open" that the render shows.
- On the open group both readers gave usable text for 17 of 20 (one page each way), so Parallel adds no readable pages over the render.
- The wording check is crude: several pages both readers showed as gone ("Job not found", "Job removed", "page doesn't exist") were not counted for either. It under-counts both equally.

Reading: the render must stay first. Parallel's reader can present a removed posting as live. The existing last-resort use of Parallel's reader (`parallelExtract`, default fetch policy) has the same exposure; Fixed the same day: `parallelExtract` now sends `fetch_policy { max_age_seconds: 600, disable_cache_fallback: true }` and rejects any result acquired more than 48 hours ago. Checked live on the 8 pages the render saw as 404/410: before, 6 returned an old copy; after, 0 of 8 return text, and a live page still reads.

Recorded cost so far: Parallel usage only (40 page reads).
<!-- /ai-test-run:2026-11-15-render-vs-parallel -->

<!-- ai-test-run:2026-11-15T15-07-26-934Z-claude-effort-ladderrun-213cce -->
### 2026-11-15 15:07 UTC · claude-effort-ladder run · editorial-plan · opus:xhigh

- Status: **finished** (updated 2026-11-15 15:12:54 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-improvement-session/planner-new`
- Command: `node scripts/claude-effort-ladder.mjs run --records ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-improvement-session/planner-new-records.jsonl --configs opus:xhigh --reps 2 --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-improvement-session/planner-new --concurrency 4`
- Records: 7 from ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-improvement-session/planner-new-records.jsonl
- Reps: 2

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| editorial-plan opus:xhigh | 14 | 14 | 0 | $6.450 |  |

Recorded cost so far: $6.450.
<!-- /ai-test-run:2026-11-15T15-07-26-934Z-claude-effort-ladderrun-213cce -->

<!-- ai-test-run:2026-11-15T15-13-10-976Z-claude-effort-ladderrun-200b63 -->
### 2026-11-15 15:13 UTC · claude-effort-ladder run · write · opus:low

- Status: **finished** (updated 2026-11-15 15:18:34 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-improvement-session/writer-new`
- Command: `node scripts/claude-effort-ladder.mjs run --records ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-improvement-session/writer-new-records.jsonl --configs opus:low --reps 1 --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-improvement-session/writer-new --concurrency 4`
- Records: 28 from ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-improvement-session/writer-new-records.jsonl
- Reps: 1

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| write opus:low | 28 | 28 | 0 | $11.29 |  |

Recorded cost so far: $11.29.
<!-- /ai-test-run:2026-11-15T15-13-10-976Z-claude-effort-ladderrun-200b63 -->

<!-- ai-test-run:2026-11-15T15-19-23-471Z-claude-effort-ladderrun-9619fb -->
### 2026-11-15 15:19 UTC · claude-effort-ladder run · improvement-panel · sonnet:high

- Status: **finished** (updated 2026-11-15 15:20:35 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-improvement-session/panel`
- Command: `node scripts/claude-effort-ladder.mjs run --records ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-improvement-session/panel-records.jsonl --configs sonnet:high --reps 2 --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-improvement-session/panel --concurrency 6`
- Records: 14 from ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-improvement-session/panel-records.jsonl
- Reps: 2

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| improvement-panel sonnet:high | 28 | 28 | 0 | $0.800 |  |

Recorded cost so far: $0.800.
<!-- /ai-test-run:2026-11-15T15-19-23-471Z-claude-effort-ladderrun-9619fb -->

<!-- ai-test-run:2026-11-15T15-31-39-394Z-claude-effort-ladderrun-31a181 -->
### 2026-11-15 15:31 UTC · claude-effort-ladder run · job-taxonomy-plan · haiku:low, haiku:medium, sonnet:low

- Status: **finished** (updated 2026-11-15 15:32:45 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/runs/taxonomy-plan`
- Command: `node scripts/claude-effort-ladder.mjs run --records ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/records/taxonomy-plan.jsonl --configs haiku:low,haiku:medium,sonnet:low --reps 2 --concurrency 3 --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/runs/taxonomy-plan`
- Records: 4 from ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/records/taxonomy-plan.jsonl
- Reps: 2

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| job-taxonomy-plan haiku:low | 8 | 8 | 0 | $0.017 |  |
| job-taxonomy-plan haiku:medium | 8 | 8 | 0 | $0.017 |  |
| job-taxonomy-plan sonnet:low | 8 | 8 | 0 | $0.163 |  |

Recorded cost so far: $0.197.
<!-- /ai-test-run:2026-11-15T15-31-39-394Z-claude-effort-ladderrun-31a181 -->

<!-- ai-test-run:2026-11-15T15-32-45-721Z-claude-effort-ladderrun-e0ef41 -->
### 2026-11-15 15:32 UTC · claude-effort-ladder run · job-compensation-assessment-batch · sonnet:low, opus:low, sonnet:medium, haiku:medium

- Status: **finished** (updated 2026-11-15 15:55:31 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/runs/comp-assessment`
- Command: `node scripts/claude-effort-ladder.mjs run --records ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/records/comp-assessment.jsonl --configs sonnet:low,opus:low,sonnet:medium,haiku:medium --reps 2 --concurrency 3 --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/runs/comp-assessment`
- Records: 5 from ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/records/comp-assessment.jsonl
- Reps: 2

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| job-compensation-assessment-batch haiku:medium | 10 | 10 | 0 | $0.252 |  |
| job-compensation-assessment-batch opus:low | 10 | 10 | 0 | $2.692 |  |
| job-compensation-assessment-batch sonnet:low | 10 | 10 | 0 | $1.588 |  |
| job-compensation-assessment-batch sonnet:medium | 10 | 10 | 0 | $1.920 |  |

Recorded cost so far: $6.453.
<!-- /ai-test-run:2026-11-15T15-32-45-721Z-claude-effort-ladderrun-e0ef41 -->

<!-- ai-test-run:2026-11-15T15-33-56-587Z-claude-effort-ladderrun-594b45 -->
### 2026-11-15 15:33 UTC · claude-effort-ladder run · write · opus:low, opus:medium, sonnet:high

- Status: **finished** (updated 2026-11-15 15:36:27 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/runs/write-cover-only`
- Command: `node scripts/claude-effort-ladder.mjs run --records ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/records/write-cover-only.jsonl --configs opus:low,opus:medium,sonnet:high --reps 3 --concurrency 3 --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/runs/write-cover-only`
- Records: 1 from ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/records/write-cover-only.jsonl
- Reps: 3

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| write opus:low | 3 | 3 | 0 | $1.143 |  |
| write opus:medium | 3 | 3 | 0 | $1.323 |  |
| write sonnet:high | 3 | 3 | 0 | $0.660 |  |

Recorded cost so far: $3.125.
<!-- /ai-test-run:2026-11-15T15-33-56-587Z-claude-effort-ladderrun-594b45 -->

<!-- ai-test-run:2026-11-15T15-35-20-680Z-claude-effort-ladderrun-536db5 -->
### 2026-11-15 15:35 UTC · claude-effort-ladder run · job-taxonomy-plan · flash:off, flash:low, flash:medium, flash:high, pro:off, pro:low, pro:medium, pro:high

- Status: **finished** (updated 2026-11-15 15:42:56 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/runs/taxonomy-plan`
- Command: `node scripts/claude-effort-ladder.mjs run --records ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/records/taxonomy-plan.jsonl --configs flash:off,flash:low,flash:medium,flash:high,pro:off,pro:low,pro:medium,pro:high --reps 2 --concurrency 4 --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/runs/taxonomy-plan`
- Records: 4 from ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/records/taxonomy-plan.jsonl
- Reps: 2

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| job-taxonomy-plan flash:high | 8 | 8 | 0 | $0.017 |  |
| job-taxonomy-plan flash:low | 8 | 8 | 0 | $0.010 |  |
| job-taxonomy-plan flash:medium | 8 | 8 | 0 | $0.015 |  |
| job-taxonomy-plan flash:off | 8 | 8 | 0 | $0.005 |  |
| job-taxonomy-plan haiku:low | 8 | 8 | 0 | $0.017 |  |
| job-taxonomy-plan haiku:medium | 8 | 8 | 0 | $0.017 |  |
| job-taxonomy-plan pro:high | 8 | 8 | 0 | $0.095 |  |
| job-taxonomy-plan pro:low | 8 | 8 | 0 | $0.072 |  |
| job-taxonomy-plan pro:medium | 8 | 8 | 0 | $0.115 |  |
| job-taxonomy-plan pro:off | 8 | 8 | 0 | $0.017 |  |
| job-taxonomy-plan sonnet:low | 8 | 8 | 0 | $0.163 |  |

Recorded cost so far: $0.542.
<!-- /ai-test-run:2026-11-15T15-35-20-680Z-claude-effort-ladderrun-536db5 -->

<!-- ai-test-run:2026-11-15T15-37-45-699Z-web-research-ab-9398f4 -->
### 2026-11-15 15:37 UTC · web-research-ab · compensation · sonnet:low

- Status: **finished** (updated 2026-11-15 15:41:39 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/compensation-sonnet-low`
- Command: `node scripts/web-research-ab.mjs --task compensation --canvas ~/Desktop/Job Search/canvas.json.before-content-pool-2026-11-04.bak --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/compensation-sonnet-low --second parallel --seed 4 --count 12 --concurrency 3 --profile sonnet:low`
- Count: 12
- Seed: 4
- Second: parallel
- summary cohorts: 452
- summary sampledCohorts: 12
- summary batches: 6
- summary distinctSourceUrls: 66

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| research merged | 6 | 6 | 0 | $0.000 | outcome per arm: summary.json |
| research native | 6 | 1 | 5 | $0.629 | outcome per arm: summary.json |
| research tavily | 6 | 6 | 0 | $0.865 | outcome per arm: summary.json |

Recorded cost so far: $1.494.
<!-- /ai-test-run:2026-11-15T15-37-45-699Z-web-research-ab-9398f4 -->

<!-- ai-test-run:2026-11-15T15-41-39-325Z-web-research-ab-218bb4 -->
### 2026-11-15 15:41 UTC · web-research-ab · compensation · haiku:medium

- Status: **finished** (updated 2026-11-15 15:56:24 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/compensation-haiku-medium`
- Command: `node scripts/web-research-ab.mjs --task compensation --canvas ~/Desktop/Job Search/canvas.json.before-content-pool-2026-11-04.bak --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/compensation-haiku-medium --second parallel --seed 4 --count 12 --concurrency 3 --profile haiku:medium`
- Count: 12
- Seed: 4
- Second: parallel
- summary cohorts: 452
- summary sampledCohorts: 12
- summary batches: 6
- summary distinctSourceUrls: 115

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| research merged | 6 | 6 | 0 | $0.000 | outcome per arm: summary.json |
| research native | 6 | 6 | 0 | $0.681 | outcome per arm: summary.json |
| research tavily | 6 | 6 | 0 | $0.132 | outcome per arm: summary.json |

Recorded cost so far: $0.813.
<!-- /ai-test-run:2026-11-15T15-41-39-325Z-web-research-ab-218bb4 -->

<!-- ai-test-run:2026-11-15T15-44-33-417Z-claude-effort-ladderrun-71a576 -->
### 2026-11-15 15:44 UTC · claude-effort-ladder run · job-listing-liveness · flash:off, flash:low, flash:medium, flash:high, pro:off, pro:low, pro:medium, pro:high

- Status: **finished** (updated 2026-11-15 15:48:22 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/runs/liveness`
- Command: `node scripts/claude-effort-ladder.mjs run --records ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/records/liveness.jsonl --configs flash:off,flash:low,flash:medium,flash:high,pro:off,pro:low,pro:medium,pro:high --reps 2 --concurrency 4 --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/runs/liveness`
- Records: 13 from ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/records/liveness.jsonl
- Reps: 2

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| job-listing-liveness flash:high | 26 | 26 | 0 | $0.011 |  |
| job-listing-liveness flash:low | 26 | 26 | 0 | $0.018 |  |
| job-listing-liveness flash:medium | 26 | 26 | 0 | $0.019 |  |
| job-listing-liveness flash:off | 26 | 26 | 0 | $0.012 |  |
| job-listing-liveness pro:high | 26 | 26 | 0 | $0.043 |  |
| job-listing-liveness pro:low | 26 | 26 | 0 | $0.050 |  |
| job-listing-liveness pro:medium | 26 | 26 | 0 | $0.088 |  |
| job-listing-liveness pro:off | 26 | 26 | 0 | $0.066 |  |

Recorded cost so far: $0.308.
<!-- /ai-test-run:2026-11-15T15-44-33-417Z-claude-effort-ladderrun-71a576 -->

<!-- ai-test-run:2026-11-15T15-46-12-984Z-blindjudge2Opussubagentsshuffledpackets-e670c1 -->
### 2026-11-15 15:46 UTC · blind judge (2 Opus subagents, shuffled packets) · write, cover-letter-only prompt

- Status: **finished** (updated 2026-11-15 15:46:12 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit`
- Records: 1 real cover-only writer prompt (one job, 2026-11-13), 3 runs per setting

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| opus:low | 3 | 3 | 0 | $1.140 | judge overall mean 6.50 (6 scores), mean rank 6.0 of 9, unsupported claims 1.67 |
| opus:medium | 3 | 3 | 0 | $1.320 | judge overall mean 7.67, mean rank 2.3, unsupported claims 1.67 |
| sonnet:high | 3 | 3 | 0 | $0.660 | judge overall mean 6.17, mean rank 6.7, unsupported claims 2.17 |

Recorded cost so far: $3.120.
- Note: One job only: a direction, not proof. Both judge passes ranked Opus medium above Opus low. Setting not changed.
<!-- /ai-test-run:2026-11-15T15-46-12-984Z-blindjudge2Opussubagentsshuffledpackets-e670c1 -->

<!-- ai-test-run:2026-11-15T15-46-13-106Z-shapeandvalidityscorescore-taxonomymjs-fe1466 -->
### 2026-11-15 15:46 UTC · shape and validity score (score-taxonomy.mjs) · job-taxonomy-plan after the 2026-11-15 salary-range sentence

- Status: **finished** (updated 2026-11-15 15:46:13 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit`
- Records: 4 real prompts of 2026-11-14/15 with the new sentence put in, 2 runs per setting

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| haiku:low | 8 | 8 | 0 | $0.017 | 0 answers over 5 salary ranges (old prompt: production rejected 2 of 4 for 6 ranges) |
| haiku:medium | 8 | 8 | 0 | $0.017 | same validity and shape, same cost |
| sonnet:low | 8 | 8 | 0 | $0.163 | 10x cost, fewer role families (8-10 vs 11-12) |
| flash:off | 8 | 8 | 0 | $0.005 | valid; one answer without exactly one Unspecified range |
| flash:low..high, pro:off..high | 48 | 48 | 0 | $0.340 | all valid; Pro costs as much as Haiku or more |

Recorded cost so far: $0.542.
<!-- /ai-test-run:2026-11-15T15-46-13-106Z-shapeandvalidityscorescore-taxonomymjs-fe1466 -->

<!-- ai-test-run:2026-11-15T15-48-22-360Z-claude-effort-ladderrun-707de7 -->
### 2026-11-15 15:48 UTC · claude-effort-ladder run · job-gap-review · flash:off, flash:low, flash:medium, flash:high, pro:off, pro:low, pro:medium, pro:high

- Status: **finished** (updated 2026-11-15 15:51:59 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/runs/gap-plants`
- Command: `node scripts/claude-effort-ladder.mjs run --records ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/records/gap-plants.jsonl --configs flash:off,flash:low,flash:medium,flash:high,pro:off,pro:low,pro:medium,pro:high --reps 2 --concurrency 4 --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/runs/gap-plants`
- Records: 4 from ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/records/gap-plants.jsonl
- Reps: 2

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| job-gap-review flash:high | 8 | 7 | 0 | $0.004 |  |
| job-gap-review flash:low | 8 | 8 | 0 | $0.020 |  |
| job-gap-review flash:medium | 8 | 8 | 0 | $0.021 |  |
| job-gap-review flash:off | 8 | 8 | 0 | $0.019 |  |
| job-gap-review pro:high | 8 | 8 | 0 | $0.045 |  |
| job-gap-review pro:low | 8 | 8 | 0 | $0.058 |  |
| job-gap-review pro:medium | 8 | 8 | 0 | $0.141 |  |
| job-gap-review pro:off | 8 | 7 | 0 | $0.112 |  |

Recorded cost so far: $0.420.
<!-- /ai-test-run:2026-11-15T15-48-22-360Z-claude-effort-ladderrun-707de7 -->

<!-- ai-test-run:2026-11-15T15-51-59-516Z-claude-effort-ladderrun-db61a9 -->
### 2026-11-15 15:51 UTC · claude-effort-ladder run · job-gap-review · flash:off, flash:low, flash:medium, flash:high, pro:off, pro:low, pro:medium, pro:high

- Status: **finished** (updated 2026-11-15 15:53:48 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/runs/gap-review`
- Command: `node scripts/claude-effort-ladder.mjs run --records ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/records/gap-review.jsonl --configs flash:off,flash:low,flash:medium,flash:high,pro:off,pro:low,pro:medium,pro:high --reps 2 --concurrency 4 --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/runs/gap-review`
- Records: 2 from ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/records/gap-review.jsonl
- Reps: 2

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| job-gap-review flash:high | 4 | 4 | 0 | $0.002 |  |
| job-gap-review flash:low | 4 | 4 | 0 | $0.003 |  |
| job-gap-review flash:medium | 4 | 4 | 0 | $0.004 |  |
| job-gap-review flash:off | 4 | 4 | 0 | $0.002 |  |
| job-gap-review pro:high | 4 | 4 | 0 | $0.022 |  |
| job-gap-review pro:low | 4 | 4 | 0 | $0.022 |  |
| job-gap-review pro:medium | 4 | 3 | 0 | $0.029 |  |
| job-gap-review pro:off | 4 | 4 | 0 | $0.017 |  |

Recorded cost so far: $0.101.
<!-- /ai-test-run:2026-11-15T15-51-59-516Z-claude-effort-ladderrun-db61a9 -->

<!-- ai-test-run:2026-11-15T15-53-09-234Z-interview-live-prepare-harnessblindOpusjudge2passes-d422ad -->
### 2026-11-15 15:53 UTC · interview-live-prepare-harness + blind Opus judge (2 passes) · qa-research under Parallel Search

- Status: **finished** (updated 2026-11-15 15:53:09 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit`
- Jobs: Appian, Intouch Insight, Reddit, Stripe (the 2026-11-09 and 11-14 bundles)

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| opus:high (2026-11-14 Parallel briefs) | 4 | 4 | 0 | $3.090 | judge mean 4.13 of 5; best on 6 of 8 judgments (3 of 4 jobs) |
| opus:medium | 4 | 4 | 0 | $1.720 | judge mean 3.86; best on Appian only; fewer sources (26 vs 40 in total) |
| sonnet:high | 4 | 4 | 0 | $1.020 | judge mean 3.71; best on 1 of 8 judgments |

Recorded cost so far: $5.830.
- Note: Cost column is the research call only. Outputs: tmp/claude-e2e/runs/2026-11-15-qa-research; judge results in the out dir under judge/qa-research. Opus high was not rerun, so its own run-to-run gap under Parallel is not measured (judge passes differed by up to 0.8 on one brief). Opus high kept.
<!-- /ai-test-run:2026-11-15T15-53-09-234Z-interview-live-prepare-harnessblindOpusjudge2passes-d422ad -->

<!-- ai-test-run:2026-11-15T15-53-48-340Z-claude-effort-ladderrun-083656 -->
### 2026-11-15 15:53 UTC · claude-effort-ladder run · job-role-snippet-screen-batch · flash:off, flash:low, flash:medium, flash:high, pro:off, pro:low, pro:medium, pro:high

- Status: **finished** (updated 2026-11-15 16:05:56 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/runs/snippet-screen`
- Command: `node scripts/claude-effort-ladder.mjs run --records ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/records/snippet-screen.jsonl --configs flash:off,flash:low,flash:medium,flash:high,pro:off,pro:low,pro:medium,pro:high --reps 2 --concurrency 4 --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/runs/snippet-screen`
- Records: 4 from ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/records/snippet-screen.jsonl
- Reps: 2

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| job-role-snippet-screen-batch flash:high | 8 | 8 | 0 | $0.023 |  |
| job-role-snippet-screen-batch flash:low | 8 | 8 | 0 | $0.020 |  |
| job-role-snippet-screen-batch flash:medium | 8 | 8 | 0 | $0.027 |  |
| job-role-snippet-screen-batch flash:off | 8 | 8 | 0 | $0.009 |  |
| job-role-snippet-screen-batch pro:high | 8 | 8 | 0 | $0.136 |  |
| job-role-snippet-screen-batch pro:low | 8 | 8 | 0 | $0.090 |  |
| job-role-snippet-screen-batch pro:medium | 8 | 8 | 0 | $0.179 |  |
| job-role-snippet-screen-batch pro:off | 8 | 8 | 0 | $0.051 |  |

Recorded cost so far: $0.536.
<!-- /ai-test-run:2026-11-15T15-53-48-340Z-claude-effort-ladderrun-083656 -->

<!-- ai-test-run:2026-11-15T15-55-47-911Z-agreementscorescore-agreementmjs-4993c7 -->
### 2026-11-15 15:55 UTC · agreement score (score-agreement.mjs) · job-compensation-assessment-batch, 5 new real prompts of 2026-11-14/15

- Status: **finished** (updated 2026-11-15 15:55:47 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit`

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| sonnet:low rerun | 10 | 10 | 0 | $1.590 | range agreement with production's Sonnet low answers 62.9% (the noise floor) |
| opus:low | 10 | 10 | 0 | $2.690 | 60.3% |
| sonnet:medium | 10 | 10 | 0 | $1.920 | 61.6% |
| haiku:medium | 10 | 10 | 0 | $0.250 | 56.1% |

Recorded cost so far: $6.450.
- Note: Valid = the response schema; the 11-12 validator rebuild script does not parse the newer prompt layout, so the app's range validator was not rerun. One small record matched 0% in every arm, reruns included. Confirms Sonnet low: no dearer setting agrees more than its own rerun.
<!-- /ai-test-run:2026-11-15T15-55-47-911Z-agreementscorescore-agreementmjs-4993c7 -->

<!-- ai-test-run:2026-11-15T15-56-24-711Z-web-research-ab-4ad443 -->
### 2026-11-15 15:56 UTC · web-research-ab · compensation · production profile

- Status: **finished** (updated 2026-11-15 16:01:56 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/compensation-production-rerun`
- Command: `node scripts/web-research-ab.mjs --task compensation --canvas ~/Desktop/Job Search/canvas.json.before-content-pool-2026-11-04.bak --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/compensation-production-rerun --second parallel --seed 4 --count 12 --concurrency 3`
- Count: 12
- Seed: 4
- Second: parallel
- summary cohorts: 452
- summary sampledCohorts: 12
- summary batches: 6
- summary distinctSourceUrls: 55

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| research merged | 6 | 6 | 0 | $0.000 | outcome per arm: summary.json |
| research native | 6 | 0 | 6 | $0.923 | outcome per arm: summary.json |
| research tavily | 6 | 6 | 0 | $0.994 | outcome per arm: summary.json |

Recorded cost so far: $1.917.
<!-- /ai-test-run:2026-11-15T15-56-24-711Z-web-research-ab-4ad443 -->

<!-- ai-test-run:2026-11-15T16-01-57-046Z-web-research-ab-444d88 -->
### 2026-11-15 16:01 UTC · web-research-ab · preference · sonnet:medium

- Status: **finished** (updated 2026-11-15 16:23:20 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/preference-sonnet-medium`
- Command: `node scripts/web-research-ab.mjs --task preference --canvas ~/Desktop/Job Search/canvas.json.before-content-pool-2026-11-04.bak --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/preference-sonnet-medium --second parallel --seed 3 --count 40 --concurrency 3 --profile sonnet:medium`
- Count: 40
- Seed: 3
- Second: parallel
- summary disagreements: 94

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| research merged | 2 | 2 | 0 | $0.000 | outcome per arm: summary.json |
| research native | 4 | 4 | 0 | $2.754 | outcome per arm: summary.json |
| research tavily | 4 | 3 | 1 | $6.538 | outcome per arm: summary.json |

Recorded cost so far: $9.291.
<!-- /ai-test-run:2026-11-15T16-01-57-046Z-web-research-ab-444d88 -->

<!-- ai-test-run:2026-11-15T16-05-56-632Z-claude-effort-ladderrun-1c22c4 -->
### 2026-11-15 16:05 UTC · claude-effort-ladder run · interview-qa-disclosures · flash:off, flash:low, flash:medium, flash:high, pro:off, pro:low, pro:medium, pro:high

- Status: **finished** (updated 2026-11-15 16:08:35 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/runs/qa-disclosures`
- Command: `node scripts/claude-effort-ladder.mjs run --records ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/records/qa-disclosures.jsonl --configs flash:off,flash:low,flash:medium,flash:high,pro:off,pro:low,pro:medium,pro:high --reps 2 --concurrency 4 --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/runs/qa-disclosures`
- Records: 2 from ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/records/qa-disclosures.jsonl
- Reps: 2

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| interview-qa-disclosures flash:high | 4 | 4 | 0 | $0.006 |  |
| interview-qa-disclosures flash:low | 4 | 4 | 0 | $0.005 |  |
| interview-qa-disclosures flash:medium | 4 | 4 | 0 | $0.004 |  |
| interview-qa-disclosures flash:off | 4 | 4 | 0 | $0.001 |  |
| interview-qa-disclosures pro:high | 4 | 4 | 0 | $0.041 |  |
| interview-qa-disclosures pro:low | 4 | 4 | 0 | $0.016 |  |
| interview-qa-disclosures pro:medium | 4 | 4 | 0 | $0.036 |  |
| interview-qa-disclosures pro:off | 4 | 4 | 0 | $0.004 |  |

Recorded cost so far: $0.113.
<!-- /ai-test-run:2026-11-15T16-05-56-632Z-claude-effort-ladderrun-1c22c4 -->

<!-- ai-test-run:2026-11-15T16-08-35-478Z-claude-effort-ladderrun-4b58bc -->
### 2026-11-15 16:08 UTC · claude-effort-ladder run · interview-qa-practice · flash:off, flash:low, flash:medium, flash:high, pro:off, pro:low, pro:medium, pro:high

- Status: **finished** (updated 2026-11-15 16:09:43 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/runs/qa-practice-order`
- Command: `node scripts/claude-effort-ladder.mjs run --records ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/records/qa-practice-order.jsonl --configs flash:off,flash:low,flash:medium,flash:high,pro:off,pro:low,pro:medium,pro:high --reps 2 --concurrency 4 --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/runs/qa-practice-order`
- Records: 1 from ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/records/qa-practice-order.jsonl
- Reps: 2

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| interview-qa-practice flash:high | 2 | 2 | 0 | $0.002 |  |
| interview-qa-practice flash:low | 2 | 2 | 0 | $0.002 |  |
| interview-qa-practice flash:medium | 2 | 2 | 0 | $0.003 |  |
| interview-qa-practice flash:off | 2 | 2 | 0 | $0.000 |  |
| interview-qa-practice pro:high | 2 | 2 | 0 | $0.011 |  |
| interview-qa-practice pro:low | 2 | 2 | 0 | $0.005 |  |
| interview-qa-practice pro:medium | 2 | 2 | 0 | $0.010 |  |
| interview-qa-practice pro:off | 2 | 2 | 0 | $0.001 |  |

Recorded cost so far: $0.034.
<!-- /ai-test-run:2026-11-15T16-08-35-478Z-claude-effort-ladderrun-4b58bc -->

<!-- ai-test-run:2026-11-15T16-09-43-325Z-claude-effort-ladderrun-613940 -->
### 2026-11-15 16:09 UTC · claude-effort-ladder run · job-role-screen-batch · flash:off, flash:low, flash:medium, flash:high, pro:off, pro:low, pro:medium, pro:high

- Status: **finished** (updated 2026-11-15 16:33:48 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/runs/role-screen`
- Command: `node scripts/claude-effort-ladder.mjs run --records ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/records/role-screen.jsonl --configs flash:off,flash:low,flash:medium,flash:high,pro:off,pro:low,pro:medium,pro:high --reps 2 --concurrency 4 --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/runs/role-screen`
- Records: 2 from ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/records/role-screen.jsonl
- Reps: 2

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| job-role-screen-batch flash:high | 4 | 1 | 3 | $0.018 |  |
| job-role-screen-batch flash:low | 4 | 2 | 2 | $0.033 |  |
| job-role-screen-batch flash:medium | 4 | 1 | 3 | $0.018 |  |
| job-role-screen-batch flash:off | 4 | 4 | 0 | $0.028 |  |
| job-role-screen-batch pro:high | 4 | 0 | 4 | $0.000 |  |
| job-role-screen-batch pro:low | 4 | 1 | 3 | $0.057 |  |
| job-role-screen-batch pro:medium | 4 | 0 | 4 | $0.000 |  |
| job-role-screen-batch pro:off | 4 | 3 | 0 | $0.089 |  |

Recorded cost so far: $0.243.
<!-- /ai-test-run:2026-11-15T16-09-43-325Z-claude-effort-ladderrun-613940 -->

<!-- ai-test-run:2026-11-15T16-10-25-558Z-ai-task-replay-116b1e -->
### 2026-11-15 16:10 UTC · ai-task-replay · job-official-posting-research · claude, claude:haiku:high, claude:sonnet:medium

- Status: **finished** (updated 2026-11-15 16:22:45 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/posting-batch`
- Command: `node scripts/ai-task-replay.mjs --task job-official-posting-research --canvas ~/Desktop/Job Search/canvas.json.before-content-pool-2026-11-04.bak --user-data ~/Library/Application Support/infinite-canvas --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/posting-batch --configs claude,claude:haiku:high,claude:sonnet:medium --batches 6 --claude-reps 2 --reps 2 --concurrency 4`

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| claude | 12 | 12 | 0 | $11.33 | agreement: run ai-task-replay-score.mjs --out <dir> |
| claude:haiku:high | 12 | 12 | 0 | $3.875 | agreement: run ai-task-replay-score.mjs --out <dir> |
| claude:sonnet:medium | 12 | 12 | 0 | $10.28 | agreement: run ai-task-replay-score.mjs --out <dir> |

Recorded cost so far: $25.49.
<!-- /ai-test-run:2026-11-15T16-10-25-558Z-ai-task-replay-116b1e -->

<!-- ai-test-run:2026-11-15T16-10-40-887Z-web-research-ab-863e5c -->
### 2026-11-15 16:10 UTC · web-research-ab · compensation · sonnet:low

- Status: **finished** (updated 2026-11-15 16:14:50 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/compensation-sonnet-low-seed3`
- Command: `node scripts/web-research-ab.mjs --task compensation --canvas ~/Desktop/Job Search/canvas.json.before-content-pool-2026-11-04.bak --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/compensation-sonnet-low-seed3 --second parallel --seed 3 --count 12 --concurrency 3 --profile sonnet:low`
- Count: 12
- Seed: 3
- Second: parallel
- summary cohorts: 452
- summary sampledCohorts: 12
- summary batches: 6
- summary distinctSourceUrls: 77

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| research merged | 6 | 6 | 0 | $0.000 | outcome per arm: summary.json |
| research native | 6 | 2 | 4 | $0.771 | outcome per arm: summary.json |
| research tavily | 6 | 6 | 0 | $0.993 | outcome per arm: summary.json |

Recorded cost so far: $1.764.
<!-- /ai-test-run:2026-11-15T16-10-40-887Z-web-research-ab-863e5c -->

<!-- ai-test-run:2026-11-15T16-14-50-984Z-web-research-ab-986eb5 -->
### 2026-11-15 16:14 UTC · web-research-ab · role-family · sonnet:low

- Status: **finished** (updated 2026-11-15 16:18:24 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/role-family-sonnet-low-seed2`
- Command: `node scripts/web-research-ab.mjs --task role-family --canvas ~/Desktop/Job Search/canvas.json.before-content-pool-2026-11-04.bak --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/role-family-sonnet-low-seed2 --second parallel --seed 2 --count 12 --concurrency 3 --profile sonnet:low`
- Count: 12
- Seed: 2
- Second: parallel
- summary roleFamilies: 54
- summary sampledRoleFamilies: 12
- summary batches: 6
- summary distinctSourceUrls: 62

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| research merged | 6 | 6 | 0 | $0.000 | outcome per arm: summary.json |
| research native | 6 | 4 | 2 | $0.612 | outcome per arm: summary.json |
| research tavily | 6 | 6 | 0 | $0.597 | outcome per arm: summary.json |

Recorded cost so far: $1.208.
<!-- /ai-test-run:2026-11-15T16-14-50-984Z-web-research-ab-986eb5 -->

<!-- ai-test-run:2026-11-15T16-18-24-988Z-web-research-ab-835f44 -->
### 2026-11-15 16:18 UTC · web-research-ab · location · sonnet:low

- Status: **finished** (updated 2026-11-15 16:21:40 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/location-sonnet-low-seed2`
- Command: `node scripts/web-research-ab.mjs --task location --canvas ~/Desktop/Job Search/canvas.json.before-content-pool-2026-11-04.bak --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/location-sonnet-low-seed2 --second parallel --seed 2 --count 24 --concurrency 3 --profile sonnet:low`
- Count: 24
- Seed: 2
- Second: parallel
- summary eligibleRows: 106
- summary skippedWithoutIdentity: 0
- summary requests: 24
- summary batches: 6

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| research native | 6 | 6 | 0 | $0.953 | outcome per arm: summary.json |
| research tavily | 6 | 6 | 0 | $1.058 | outcome per arm: summary.json |

Recorded cost so far: $2.011.
<!-- /ai-test-run:2026-11-15T16-18-24-988Z-web-research-ab-835f44 -->

<!-- ai-test-run:2026-11-15T16-24-00-097Z-web-research-ab-e6ef73 -->
### 2026-11-15 16:24 UTC · web-research-ab · preference · sonnet:medium

- Status: **finished** (updated 2026-11-15 16:54:14 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/preference-sonnet-medium-run2`
- Command: `node scripts/web-research-ab.mjs --task preference --canvas ~/Desktop/Job Search/canvas.json.before-content-pool-2026-11-04.bak --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/preference-sonnet-medium-run2 --second parallel --seed 3 --count 40 --concurrency 3 --profile sonnet:medium`
- Count: 40
- Seed: 3
- Second: parallel
- summary disagreements: 32

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| research merged | 2 | 2 | 0 | $0.000 | outcome per arm: summary.json |
| research native | 4 | 4 | 0 | $3.027 | outcome per arm: summary.json |
| research tavily | 4 | 4 | 0 | $6.397 | outcome per arm: summary.json |

Recorded cost so far: $9.423.
<!-- /ai-test-run:2026-11-15T16-24-00-097Z-web-research-ab-e6ef73 -->

<!-- ai-test-run:2026-11-15T16-24-00-105Z-official-research-search-abParallelarmkeyedai-task-replaybatches-135e02 -->
### 2026-11-15 16:24 UTC · official-research-search-ab (Parallel arm, keyed) + ai-task-replay batches · job-official-posting-research under Parallel Search

- Status: **finished** (updated 2026-11-15 16:24:00 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit`
- Canvas: canvas.json.before-content-pool-2026-11-04.bak

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| opus:low (production) | 90 | 90 | 0 | $13.70 | exact posting of 30: 28 (seed 2, 11-14), 27 and 27 (seed 3) |
| sonnet:medium | 60 | 60 | 0 | $5.110 | 27 (seed 2), 28 (seed 3) |
| sonnet:low | 30 | 30 | 0 | $2.200 | 27 (seed 2) |
| haiku:high | 60 | 60 | 0 | $0.500 | 27 (seed 2), 28 (seed 3); about twice the searches per job |
| haiku:medium | 60 | 60 | 0 | $0.360 | 26 (seed 2), 28 (seed 3) |
| haiku:low | 30 | 30 | 0 | $0.160 | 26 (seed 2) |
| batched replay, opus:low | 12 | 12 | 0 | $11.33 | 6 real 12-job batches x 2 runs: 48 confirmed postings named, own-run agreement 68.1% |
| batched replay, haiku:high | 12 | 12 | 0 | $3.870 | 59 confirmed postings named; 100% valid |
| batched replay, sonnet:medium | 12 | 12 | 0 | $10.28 | 55 confirmed postings named |
| 11 jobs with no confirmed posting, haiku:high | 11 | 11 | 0 | $0.330 | offered leads for 9 |
| 11 jobs with no confirmed posting, opus:low | 11 | 11 | 0 | $2.290 | offered leads for 11 |

Recorded cost so far: $50.13.
- Note: An unkeyed first attempt (Sonnet low seed 2, Sonnet medium seed 3) hit the anonymous Parallel server's throttle and found nothing; discarded (folders named THROTTLED-discard), and the tool now uses the Keychain key. Batched score: score-posting-batch.mjs counts confirmed board postings named in each reply.
<!-- /ai-test-run:2026-11-15T16-24-00-105Z-official-research-search-abParallelarmkeyedai-task-replaybatches-135e02 -->

<!-- ai-test-run:2026-11-15T16-24-00-147Z-web-research-ab--secondparallelParallelarm-51b8c9 -->
### 2026-11-15 16:24 UTC · web-research-ab --second parallel (Parallel arm) · job-compensation-research-batch under Parallel Search

- Status: **finished** (updated 2026-11-15 16:24:00 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit`

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| salary seed 4, sonnet:medium (production; 11-14 and rerun) | 12 | 11 | 1 | $2.050 | cohorts with a verified source 9 and 10 of 12; verified sources 20 and 19 |
| salary seed 4, sonnet:low | 6 | 6 | 0 | $0.870 | 12 of 12; 24 sources |
| salary seed 4, haiku:medium | 6 | 6 | 0 | $0.130 | 5 of 12; 11 sources |
| salary seed 3, sonnet:medium (11-14) | 6 | 6 | 0 | $1.190 | 12 of 12; 26 sources |
| salary seed 3, sonnet:low | 6 | 6 | 0 | $0.990 | 12 of 12; 27 sources |
| experience bands seed 2, sonnet:medium (11-14) | 6 | 6 | 0 | $0.740 | two verified hosts 10 of 12; year bands 12; 45 sources |
| experience bands seed 2, sonnet:low | 6 | 6 | 0 | $0.600 | two verified hosts 10 of 12; year bands 11; 36 sources |
| job location seed 2, sonnet:medium (11-14) | 6 | 6 | 0 | $1.230 | correct 9, wrong 0 of 24 |
| job location seed 2, sonnet:low | 6 | 6 | 0 | $1.060 | correct 9, wrong 1 of 24 |

Recorded cost so far: $8.860.
- Note: n is research replies. Costs are the Parallel arm only; each run also ran the built-in comparison arm.
<!-- /ai-test-run:2026-11-15T16-24-00-147Z-web-research-ab--secondparallelParallelarm-51b8c9 -->

<!-- ai-test-run:2026-11-15T16-33-48-715Z-claude-effort-ladderrun-dd6f7a -->
### 2026-11-15 16:33 UTC · claude-effort-ladder run · job-preference-interpretation · flash:off, flash:low, flash:medium, flash:high, pro:off, pro:low, pro:medium, pro:high

- Status: **finished** (updated 2026-11-15 16:48:09 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/b10/job-preference-interpretation`
- Command: `node scripts/claude-effort-ladder.mjs run --records ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/b10/job-preference-interpretation.records.jsonl --configs flash:off,flash:low,flash:medium,flash:high,pro:off,pro:low,pro:medium,pro:high --reps 2 --concurrency 4 --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/b10/job-preference-interpretation`
- Records: 4 from ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/b10/job-preference-interpretation.records.jsonl
- Reps: 2

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| job-preference-interpretation flash:high | 8 | 6 | 0 | $0.027 |  |
| job-preference-interpretation flash:low | 8 | 2 | 0 | $0.030 |  |
| job-preference-interpretation flash:medium | 8 | 6 | 0 | $0.036 |  |
| job-preference-interpretation flash:off | 8 | 7 | 0 | $0.016 |  |
| job-preference-interpretation pro:high | 8 | 7 | 0 | $0.211 |  |
| job-preference-interpretation pro:low | 8 | 6 | 0 | $0.160 |  |
| job-preference-interpretation pro:medium | 8 | 6 | 0 | $0.230 |  |
| job-preference-interpretation pro:off | 8 | 4 | 0 | $0.053 |  |

Recorded cost so far: $0.762.
<!-- /ai-test-run:2026-11-15T16-33-48-715Z-claude-effort-ladderrun-dd6f7a -->

<!-- ai-test-run:2026-11-15T16-48-09-500Z-claude-effort-ladderrun-b91167 -->
### 2026-11-15 16:48 UTC · claude-effort-ladder run · job-role-audit · flash:off, flash:low, flash:medium, flash:high, pro:off, pro:low, pro:medium, pro:high

- Status: **finished** (updated 2026-11-15 16:52:23 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/b10/job-role-audit`
- Command: `node scripts/claude-effort-ladder.mjs run --records ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/b10/job-role-audit.records.jsonl --configs flash:off,flash:low,flash:medium,flash:high,pro:off,pro:low,pro:medium,pro:high --reps 2 --concurrency 4 --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/b10/job-role-audit`
- Records: 4 from ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/b10/job-role-audit.records.jsonl
- Reps: 2

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| job-role-audit flash:high | 8 | 2 | 0 | $0.007 |  |
| job-role-audit flash:low | 8 | 0 | 0 | $0.012 |  |
| job-role-audit flash:medium | 8 | 1 | 0 | $0.013 |  |
| job-role-audit flash:off | 8 | 2 | 0 | $0.009 |  |
| job-role-audit pro:high | 8 | 8 | 0 | $0.053 |  |
| job-role-audit pro:low | 8 | 8 | 0 | $0.040 |  |
| job-role-audit pro:medium | 8 | 8 | 0 | $0.090 |  |
| job-role-audit pro:off | 8 | 6 | 0 | $0.037 |  |

Recorded cost so far: $0.261.
<!-- /ai-test-run:2026-11-15T16-48-09-500Z-claude-effort-ladderrun-b91167 -->

<!-- ai-test-run:2026-11-15T16-52-23-609Z-claude-effort-ladderrun-c536a9 -->
### 2026-11-15 16:52 UTC · claude-effort-ladder run · job-preference-research-batch-assessment · flash:off, flash:low, flash:medium, flash:high, pro:off, pro:low, pro:medium, pro:high

- Status: **finished** (updated 2026-11-15 16:55:31 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/b10/job-preference-research-batch-assessment`
- Command: `node scripts/claude-effort-ladder.mjs run --records ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/b10/job-preference-research-batch-assessment.records.jsonl --configs flash:off,flash:low,flash:medium,flash:high,pro:off,pro:low,pro:medium,pro:high --reps 2 --concurrency 4 --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/b10/job-preference-research-batch-assessment`
- Records: 1 from ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/b10/job-preference-research-batch-assessment.records.jsonl
- Reps: 2

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| job-preference-research-batch-assessment flash:high | 2 | 2 | 0 | $0.009 |  |
| job-preference-research-batch-assessment flash:low | 2 | 2 | 0 | $0.009 |  |
| job-preference-research-batch-assessment flash:medium | 2 | 2 | 0 | $0.009 |  |
| job-preference-research-batch-assessment flash:off | 2 | 2 | 0 | $0.006 |  |
| job-preference-research-batch-assessment pro:high | 2 | 2 | 0 | $0.040 |  |
| job-preference-research-batch-assessment pro:low | 2 | 2 | 0 | $0.037 |  |
| job-preference-research-batch-assessment pro:medium | 2 | 2 | 0 | $0.044 |  |
| job-preference-research-batch-assessment pro:off | 2 | 2 | 0 | $0.018 |  |

Recorded cost so far: $0.173.
<!-- /ai-test-run:2026-11-15T16-52-23-609Z-claude-effort-ladderrun-c536a9 -->

<!-- ai-test-run:2026-11-15T16-54-14-221Z-web-research-ab-0d7607 -->
### 2026-11-15 16:54 UTC · web-research-ab · preference · sonnet:low

- Status: **finished** (updated 2026-11-15 17:19:53 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/preference-sonnet-low`
- Command: `node scripts/web-research-ab.mjs --task preference --canvas ~/Desktop/Job Search/canvas.json.before-content-pool-2026-11-04.bak --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/preference-sonnet-low --second parallel --seed 3 --count 40 --concurrency 3 --profile sonnet:low`
- Count: 40
- Seed: 3
- Second: parallel
- summary disagreements: 100

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| research merged | 2 | 2 | 0 | $0.000 | outcome per arm: summary.json |
| research native | 4 | 4 | 0 | $2.562 | outcome per arm: summary.json |
| research tavily | 4 | 3 | 1 | $5.530 | outcome per arm: summary.json |

Recorded cost so far: $8.092.
<!-- /ai-test-run:2026-11-15T16-54-14-221Z-web-research-ab-0d7607 -->

<!-- ai-test-run:2026-11-15T16-55-31-215Z-claude-effort-ladderrun-ad7b93 -->
### 2026-11-15 16:55 UTC · claude-effort-ladder run · job-location-consolidation-confirmation · flash:off, flash:low, flash:medium, flash:high, pro:off, pro:low, pro:medium, pro:high

- Status: **finished** (updated 2026-11-15 16:56:34 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/b10/job-location-consolidation-planted`
- Command: `node scripts/claude-effort-ladder.mjs run --records ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/b10/job-location-consolidation-planted.records.jsonl --configs flash:off,flash:low,flash:medium,flash:high,pro:off,pro:low,pro:medium,pro:high --reps 2 --concurrency 4 --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/b10/job-location-consolidation-planted`
- Records: 2 from ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/b10/job-location-consolidation-planted.records.jsonl
- Reps: 2

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| job-location-consolidation-confirmation flash:high | 4 | 0 | 0 | $0.004 |  |
| job-location-consolidation-confirmation flash:low | 4 | 0 | 0 | $0.007 |  |
| job-location-consolidation-confirmation flash:medium | 4 | 0 | 0 | $0.008 |  |
| job-location-consolidation-confirmation flash:off | 4 | 0 | 0 | $0.004 |  |
| job-location-consolidation-confirmation pro:high | 4 | 0 | 0 | $0.010 |  |
| job-location-consolidation-confirmation pro:low | 4 | 0 | 0 | $0.020 |  |
| job-location-consolidation-confirmation pro:medium | 4 | 0 | 0 | $0.031 |  |
| job-location-consolidation-confirmation pro:off | 4 | 0 | 0 | $0.028 |  |

Recorded cost so far: $0.114.
<!-- /ai-test-run:2026-11-15T16-55-31-215Z-claude-effort-ladderrun-ad7b93 -->

<!-- ai-test-run:2026-11-15T16-56-34-751Z-claude-effort-ladderrun-c48d39 -->
### 2026-11-15 16:56 UTC · claude-effort-ladder run · job-location-consolidation-confirmation · flash:off, flash:low, flash:medium, flash:high, pro:off, pro:low, pro:medium, pro:high

- Status: **finished** (updated 2026-11-15 16:57:23 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/b10/job-location-consolidation-subtle`
- Command: `node scripts/claude-effort-ladder.mjs run --records ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/b10/job-location-consolidation-subtle.records.jsonl --configs flash:off,flash:low,flash:medium,flash:high,pro:off,pro:low,pro:medium,pro:high --reps 2 --concurrency 4 --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/b10/job-location-consolidation-subtle`
- Records: 2 from ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/b10/job-location-consolidation-subtle.records.jsonl
- Reps: 2

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| job-location-consolidation-confirmation flash:high | 4 | 4 | 0 | $0.002 |  |
| job-location-consolidation-confirmation flash:low | 4 | 4 | 0 | $0.005 |  |
| job-location-consolidation-confirmation flash:medium | 4 | 4 | 0 | $0.004 |  |
| job-location-consolidation-confirmation flash:off | 4 | 4 | 0 | $0.003 |  |
| job-location-consolidation-confirmation pro:high | 4 | 4 | 0 | $0.009 |  |
| job-location-consolidation-confirmation pro:low | 4 | 4 | 0 | $0.010 |  |
| job-location-consolidation-confirmation pro:medium | 4 | 4 | 0 | $0.019 |  |
| job-location-consolidation-confirmation pro:off | 4 | 4 | 0 | $0.021 |  |

Recorded cost so far: $0.072.
<!-- /ai-test-run:2026-11-15T16-56-34-751Z-claude-effort-ladderrun-c48d39 -->

<!-- ai-test-run:2026-11-15T16-57-56-438Z-claude-effort-ladderrun-88293f -->
### 2026-11-15 16:57 UTC · claude-effort-ladder run · job-preference-research-batch-assessment · flash:off, flash:low, flash:medium, flash:high, sonnet:low

- Status: **finished** (updated 2026-11-15 17:11:40 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/runs/pref-assessment-new`
- Command: `node scripts/claude-effort-ladder.mjs run --records ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/records/pref-assessment-new.jsonl --configs flash:off,flash:low,flash:medium,flash:high,sonnet:low --reps 2 --concurrency 4 --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/runs/pref-assessment-new`
- Records: 7 from ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/records/pref-assessment-new.jsonl
- Reps: 2

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| job-preference-research-batch-assessment flash:high | 14 | 14 | 0 | $0.137 |  |
| job-preference-research-batch-assessment flash:low | 14 | 14 | 0 | $0.117 |  |
| job-preference-research-batch-assessment flash:medium | 14 | 13 | 1 | $0.140 |  |
| job-preference-research-batch-assessment flash:off | 14 | 14 | 0 | $0.063 |  |
| job-preference-research-batch-assessment sonnet:low | 14 | 14 | 0 | $2.328 |  |

Recorded cost so far: $2.785.
<!-- /ai-test-run:2026-11-15T16-57-56-438Z-claude-effort-ladderrun-88293f -->

<!-- ai-test-run:2026-11-15T17-11-40-352Z-claude-effort-ladderrun-a52f8d -->
### 2026-11-15 17:11 UTC · claude-effort-ladder run · job-role-audit · flash:off, flash:low, flash:medium, flash:high, pro:low, haiku:high

- Status: **finished** (updated 2026-11-15 17:13:39 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/runs/role-audit-new`
- Command: `node scripts/claude-effort-ladder.mjs run --records ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/records/role-audit-new.jsonl --configs flash:off,flash:low,flash:medium,flash:high,pro:low,haiku:high --reps 2 --concurrency 4 --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/runs/role-audit-new`
- Records: 4 from ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/records/role-audit-new.jsonl
- Reps: 2

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| job-role-audit flash:high | 8 | 8 | 0 | $0.007 |  |
| job-role-audit flash:low | 8 | 8 | 0 | $0.012 |  |
| job-role-audit flash:medium | 8 | 8 | 0 | $0.011 |  |
| job-role-audit flash:off | 8 | 8 | 0 | $0.009 |  |
| job-role-audit haiku:high | 8 | 8 | 0 | $0.035 |  |
| job-role-audit pro:low | 8 | 8 | 0 | $0.069 |  |

Recorded cost so far: $0.142.
<!-- /ai-test-run:2026-11-15T17-11-40-352Z-claude-effort-ladderrun-a52f8d -->

<!-- ai-test-run:2026-11-15T17-13-39-920Z-claude-effort-ladderrun-e4ac99 -->
### 2026-11-15 17:13 UTC · claude-effort-ladder run · job-gap-review · flash:off, flash:low, flash:medium, haiku:high

- Status: **finished** (updated 2026-11-15 17:14:42 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/runs/gap-review-new`
- Command: `node scripts/claude-effort-ladder.mjs run --records ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/records/gap-review-new.jsonl --configs flash:off,flash:low,flash:medium,haiku:high --reps 2 --concurrency 4 --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/runs/gap-review-new`
- Records: 4 from ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/records/gap-review-new.jsonl
- Reps: 2

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| job-gap-review flash:low | 8 | 8 | 0 | $0.006 |  |
| job-gap-review flash:medium | 8 | 8 | 0 | $0.009 |  |
| job-gap-review flash:off | 8 | 8 | 0 | $0.004 |  |
| job-gap-review haiku:high | 8 | 7 | 0 | $0.088 |  |

Recorded cost so far: $0.106.
<!-- /ai-test-run:2026-11-15T17-13-39-920Z-claude-effort-ladderrun-e4ac99 -->

<!-- ai-test-run:2026-11-15T17-15-58-645Z-claude-effort-ladderrunwithDeepSeekarmsthe11-10and11-12scorers-54effc -->
### 2026-11-15 17:15 UTC · claude-effort-ladder run with DeepSeek arms + the 11-10 and 11-12 scorers · DeepSeek Flash and Pro (reasoning off, low, medium, high) on worker and interview calls never measured with DeepSeek

- Status: **finished** (updated 2026-11-15 17:15:58 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit`

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| job-gap-review, flash:low | 20 | 20 | 0 | $0.030 | 11-12 real 18/18 rows; planted 8/8 caught, 0 false alarms; 4 new real prompts 97.4% (Haiku high rerun 97.4%, 7 of 8 valid). ROUTED |
| job-gap-review, other arms | 76 | 73 | 0 | $0.400 | flash:off missed 1 planted row and fell to 89.5% on new prompts; flash:medium 89.5%; flash:high and pro:off each had an invalid answer |
| job-role-audit, flash:low | 16 | 8 | 0 | $0.020 | new real audits 97.8% (Haiku high rerun 95.6%), 8/8 valid; 11-10 audits title/removed/added overlap 0.986/0.875/1.0 = Haiku high (those 8 fail only the old 800-character cap stored in the records). ROUTED |
| job-location-consolidation-confirmation, flash:low | 8 | 4 | 0 | $0.010 | planted pairs 40/40 right (Haiku low 40/40); flash:off 39/40, pro:off 38/40; the 4 invalid are the planted prompts exceeding the 4-pair schema, as for every arm. ROUTED |
| job-preference-research-batch-assessment, flash:low | 16 | 16 | 0 | $0.130 | 11-10 batch 40/40, but 7 newer real prompts 95.1% vs a Sonnet low rerun 98.8%. Stays Sonnet low |
| job-listing-liveness, all arms | 208 | 208 | 0 | $0.300 | planted 17-20 of 20 (flash:off 20/20) but real pages 6/8 (flash:high 7/8) vs Haiku medium 8/8. Stays Haiku medium |
| job-role-snippet-screen-batch, all arms | 64 | 64 | 0 | $0.500 | Flash 59-65% agreement with 102-123 extra removals; Pro 72% at 2-4x Haiku's cost. Stays Haiku medium |
| job-role-screen-batch, all arms | 32 | 14 | 18 | $0.300 | flash:off 49% agreement, 1,008 extra removals; reasoning arms hit the 32k output cap on the 1,975-title prompt. Stays Haiku low |
| job-preference-interpretation, all arms | 64 | 44 | 0 | $0.760 | 2-7 of 8 valid; strict-requirement overlap 0.01-0.18 (Haiku 0.18-0.27). Stays Haiku medium |
| qa-disclosures, all arms | 32 | 32 | 0 | $0.110 | only pro:medium matched (100%); its neighbours pro:low 71% and pro:high 81%, Flash 42-81%. Stays Sonnet low |
| job-taxonomy-plan, all arms | 64 | 64 | 0 | $0.350 | valid, but Flash with reasoning and Pro cost as much as Haiku low or more; flash:off had one answer without exactly one Unspecified range. Stays Haiku low |

Recorded cost so far: $2.910.
- Note: Agreement is against production's stored answers, with a rerun of the current Claude setting as the noise floor where shown. Records are the 2026-11-10 and 11-12 sets plus accepted samples through 2026-11-15.
<!-- /ai-test-run:2026-11-15T17-15-58-645Z-claude-effort-ladderrunwithDeepSeekarmsthe11-10and11-12scorers-54effc -->

<!-- ai-test-run:2026-11-15T17-20-11-157Z-web-research-ab-efe17e -->
### 2026-11-15 17:20 UTC · web-research-ab · preference · haiku:high

- Status: **finished** (updated 2026-11-15 17:42:40 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/preference-haiku-high`
- Command: `node scripts/web-research-ab.mjs --task preference --canvas ~/Desktop/Job Search/canvas.json.before-content-pool-2026-11-04.bak --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/preference-haiku-high --second parallel --seed 3 --count 40 --concurrency 3 --profile haiku:high`
- Count: 40
- Seed: 3
- Second: parallel
- summary disagreements: 2

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| research merged | 2 | 1 | 1 | $0.000 | outcome per arm: summary.json |
| research native | 4 | 2 | 2 | $2.182 | outcome per arm: summary.json |
| research tavily | 4 | 2 | 2 | $1.942 | outcome per arm: summary.json |

Recorded cost so far: $4.123.
<!-- /ai-test-run:2026-11-15T17-20-11-157Z-web-research-ab-efe17e -->

<!-- ai-test-run:2026-11-15T17-42-40-442Z-web-research-ab-a72d21 -->
### 2026-11-15 17:42 UTC · web-research-ab · preference · sonnet:low

- Status: **finished** (updated 2026-11-15 18:15:33 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/preference-sonnet-low-run2`
- Command: `node scripts/web-research-ab.mjs --task preference --canvas ~/Desktop/Job Search/canvas.json.before-content-pool-2026-11-04.bak --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit/preference-sonnet-low-run2 --second parallel --seed 3 --count 40 --concurrency 3 --profile sonnet:low`
- Count: 40
- Seed: 3
- Second: parallel
- summary disagreements: 0

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| research merged | 2 | 2 | 0 | $0.000 | outcome per arm: summary.json |
| research native | 4 | 4 | 0 | $2.433 | outcome per arm: summary.json |
| research tavily | 4 | 3 | 1 | $4.473 | outcome per arm: summary.json |

Recorded cost so far: $6.905.
<!-- /ai-test-run:2026-11-15T17-42-40-442Z-web-research-ab-a72d21 -->

<!-- ai-test-run:2026-11-15T18-16-04-008Z-web-research-ab--taskpreference--secondparallel--seed3--count40Parallelarm-ff9ed2 -->
### 2026-11-15 18:16 UTC · web-research-ab --task preference --second parallel --seed 3 --count 40 (Parallel arm) · job-preference-research-batch under Parallel Search

- Status: **finished** (updated 2026-11-15 18:16:04 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit`

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| opus:medium (production, 11-14) | 6 | 4 | 2 | $23.90 | rerun: 158 confirmed / 2 conflicts / 12 unverified of 172; first pass lost the 121-section batch twice |
| sonnet:medium run 1 | 4 | 3 | 1 | $6.540 | 171 / 2 / 7 of 180; 43 jobs accepted, 2 filtered |
| sonnet:medium run 2 | 4 | 4 | 0 | $6.400 | 175 / 2 / 3; 43 accepted, 2 filtered |
| sonnet:low run 1 | 4 | 3 | 1 | $5.530 | 173 / 2 / 5; 43 accepted, 2 filtered |
| sonnet:low run 2 | 4 | 3 | 1 | $4.470 | no outcomes: the assessment was rejected 3 times (no direct URL from the research section) |
| haiku:high | 4 | 2 | 2 | $1.940 | 36 / 0 / 144; both conflicts missed |

Recorded cost so far: $48.78.
- Note: n is research replies; cost is the research step of the Parallel arm. Sonnet medium applied.
<!-- /ai-test-run:2026-11-15T18-16-04-008Z-web-research-ab--taskpreference--secondparallel--seed3--count40Parallelarm-ff9ed2 -->

<!-- ai-test-run:2026-11-15T18-16-04-048Z-blindjudge1Opussubagent-15a8cd -->
### 2026-11-15 18:16 UTC · blind judge (1 Opus subagent) · qa-practice-order with DeepSeek arms

- Status: **finished** (updated 2026-11-15 18:16:04 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-15-policy-audit`
- Records: the one real 26-question prompt of 2026-11-12

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| production opus:low | 1 | 1 | 0 | $0.014 | judge 8 of 10 |
| flash:low | 2 | 2 | 0 | $0.002 | 9 and 9. ROUTED |
| flash:high | 2 | 2 | 0 | $0.002 | 9 and 8 |
| pro:low, pro:high | 4 | 4 | 0 | $0.016 | 8 and 9 each |
| flash:off | 2 | 1 | 1 | $0.000 | 6, and 3 for a repeated question |

Recorded cost so far: $0.034.
<!-- /ai-test-run:2026-11-15T18-16-04-048Z-blindjudge1Opussubagent-15a8cd -->

<!-- ai-test-run:2026-11-16T12-45-03-468Z-claude-effort-ladderrun-b9c5b2 -->
### 2026-11-16 12:45 UTC · claude-effort-ladder run · job-role-screen-batch · haiku:low

- Status: **finished** (updated 2026-11-16 12:45:17 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-16-test-posting-screen`
- Command: `node scripts/claude-effort-ladder.mjs run --records ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-16-test-posting-screen.records.jsonl --configs haiku:low --reps 3 --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-16-test-posting-screen --concurrency 3`
- Records: 1 from ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-16-test-posting-screen.records.jsonl
- Reps: 3

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| job-role-screen-batch haiku:low | 3 | 3 | 0 | $0.007 |  |

Recorded cost so far: $0.007.
<!-- /ai-test-run:2026-11-16T12-45-03-468Z-claude-effort-ladderrun-b9c5b2 -->

<!-- ai-test-run:2026-11-16T12-46-35-955Z-claude-effort-ladderrun-3124f4 -->
### 2026-11-16 12:46 UTC · claude-effort-ladder run · job-role-screen-batch · haiku:low

- Status: **finished** (updated 2026-11-16 12:46:49 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-16-test-posting-screen-before`
- Command: `node scripts/claude-effort-ladder.mjs run --records ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-16-test-posting-screen-before.records.jsonl --configs haiku:low --reps 5 --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-16-test-posting-screen-before --concurrency 5`
- Records: 1 from ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-16-test-posting-screen-before.records.jsonl
- Reps: 5

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| job-role-screen-batch haiku:low | 5 | 5 | 0 | $0.010 |  |

Recorded cost so far: $0.010.
<!-- /ai-test-run:2026-11-16T12-46-35-955Z-claude-effort-ladderrun-3124f4 -->

<!-- ai-test-run:2026-11-16T12-46-35-955Z-claude-effort-ladderrun-33668c -->
### 2026-11-16 12:46 UTC · claude-effort-ladder run · job-role-screen-batch · haiku:low

- Status: **finished** (updated 2026-11-16 12:46:49 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-16-test-posting-screen`
- Command: `node scripts/claude-effort-ladder.mjs run --records ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-16-test-posting-screen.records.jsonl --configs haiku:low --reps 5 --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-16-test-posting-screen --concurrency 3`
- Records: 1 from ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-16-test-posting-screen.records.jsonl
- Reps: 5

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| job-role-screen-batch haiku:low | 5 | 5 | 0 | $0.010 |  |

Recorded cost so far: $0.010.
<!-- /ai-test-run:2026-11-16T12-46-35-955Z-claude-effort-ladderrun-33668c -->

<!-- ai-test-run:2026-11-16T13-17-55-000Z-claude-effort-ladderrun-0d7ff5 -->
### 2026-11-16 13:17 UTC · claude-effort-ladder run · write · opus:medium

- Status: **finished** (updated 2026-11-16 13:21:44 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-16-improvement-session/writer-new`
- Command: `node scripts/claude-effort-ladder.mjs run --records ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-16-improvement-session/writer-new-records.jsonl --configs opus:medium --reps 1 --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-16-improvement-session/writer-new --concurrency 5`
- Records: 15 from ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-16-improvement-session/writer-new-records.jsonl
- Reps: 1

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| write opus:medium | 15 | 15 | 0 | $7.266 |  |

Recorded cost so far: $7.266.
<!-- /ai-test-run:2026-11-16T13-17-55-000Z-claude-effort-ladderrun-0d7ff5 -->

<!-- ai-test-run:2026-11-16T13-21-59-558Z-claude-effort-ladderrun-f5ac5d -->
### 2026-11-16 13:21 UTC · claude-effort-ladder run · improvement-panel · sonnet:high

- Status: **finished** (updated 2026-11-16 13:23:09 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-16-improvement-session/panel`
- Command: `node scripts/claude-effort-ladder.mjs run --records ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-16-improvement-session/panel-records.jsonl --configs sonnet:high --reps 2 --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-16-improvement-session/panel --concurrency 6`
- Records: 15 from ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-16-improvement-session/panel-records.jsonl
- Reps: 2

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| improvement-panel sonnet:high | 30 | 30 | 0 | $0.775 |  |

Recorded cost so far: $0.775.
<!-- /ai-test-run:2026-11-16T13-21-59-558Z-claude-effort-ladderrun-f5ac5d -->

<!-- ai-test-run:2026-11-16T13-23-16-724Z-claude-effort-ladderrun-898ef5 -->
### 2026-11-16 13:23 UTC · claude-effort-ladder run · write · opus:medium

- Status: **finished** (updated 2026-11-16 13:26:42 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-16-improvement-session/writer-c`
- Command: `node scripts/claude-effort-ladder.mjs run --records ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-16-improvement-session/writer-c-records.jsonl --configs opus:medium --reps 1 --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-16-improvement-session/writer-c --concurrency 5`
- Records: 15 from ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-16-improvement-session/writer-c-records.jsonl
- Reps: 1

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| write opus:medium | 15 | 15 | 0 | $7.101 |  |

Recorded cost so far: $7.101.
<!-- /ai-test-run:2026-11-16T13-23-16-724Z-claude-effort-ladderrun-898ef5 -->

<!-- ai-test-run:2026-11-16T13-26-48-135Z-claude-effort-ladderrun-b47e0e -->
### 2026-11-16 13:26 UTC · claude-effort-ladder run · improvement-panel · sonnet:high

- Status: **finished** (updated 2026-11-16 13:27:49 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-16-improvement-session/panel-writer-c`
- Command: `node scripts/claude-effort-ladder.mjs run --records ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-16-improvement-session/panel-writer-c-records.jsonl --configs sonnet:high --reps 2 --out ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-16-improvement-session/panel-writer-c --concurrency 8`
- Records: 15 from ~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-16-improvement-session/panel-writer-c-records.jsonl
- Reps: 2

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| improvement-panel sonnet:high | 30 | 30 | 0 | $0.816 |  |

Recorded cost so far: $0.816.
<!-- /ai-test-run:2026-11-16T13-26-48-135Z-claude-effort-ladderrun-b47e0e -->

<!-- ai-test-run:2026-11-19T05-52-59-158Z-employer-posting-read-measure-2a2dd6 -->
### 2026-11-19 05:52 UTC · employer-posting-read-measure · job-official-posting-research + job-official-posting-match · Skip-time employer-posting read on unread Google listings (no description, no location)

- Status: **finished** (updated 2026-11-19 05:52:59 UTC)
- Out dir: `~/Library/Application Support/infinite-canvas/ai-test-runs/2026-11-19-employer-posting-read`
- Pool: 50 unread Google listings saved by the 2026-11-19 scan
- Cost per listing read: about 1.53 USD in the 12 sample

| Arm | n | Valid | Failed | Cost | Notes |
|---|---|---|---|---|---|
| sample-12 seed 7 | 12 | 3 | 9 | $4.590 | 3 read (found, L2); 7 ambiguous (5 semantic-uncertain, 2 source-unproven), 1 not-found, 1 link-only; 42 AI calls (2 research, 40 match), 4.8 min wall |
| probe-2 seed 1 | 1 | 1 | 0 | $0.100 | found L2, 3 AI calls, 0.5 min |

Recorded cost so far: $4.690.
- Note: Rows carried title, company and link only; in the app they also carry the card location, which may help the judges. Not run through the app's own worker.
<!-- /ai-test-run:2026-11-19T05-52-59-158Z-employer-posting-read-measure-2a2dd6 -->
