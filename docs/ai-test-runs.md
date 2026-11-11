# AI test run log

Written by the test tools themselves while they run (`scripts/ai-test-journal.mjs`): `claude-effort-ladder.mjs`, `ai-task-replay.mjs`, `web-research-ab.mjs` and `live-bundle-harness.mjs`. Each section is one run. It appears when the run starts, is rewritten as results arrive, and is marked interrupted if the process is stopped, so the numbers survive even if the session that started the run does not.

These are raw results, kept whether or not a decision was made. Conclusions go in `ai-model-selection.md`, which should cite the run here. Only counts and costs are written; prompts and answers stay in each run's private out dir (default under `~/Library/Application Support/infinite-canvas/ai-test-runs/`).

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
