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
