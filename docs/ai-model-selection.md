# AI model and effort selection

This file is the record of which model and effort each Claude call uses, why, and what has been measured. Read it before testing any call again: a call marked **Proven** needs no re-test unless one of the re-test triggers below applies.

Settings live in code:

- Background tasks: `electron/ipc/claudeTaskProfiles.js` (`CLAUDE_TASK_PROFILES`).
- Application and interview stages: `electron/ipc/careerWritingCore.js` (`APPLICATION_STAGE_PROFILES`, `INTERVIEW_QA_STAGE_PROFILES`); stages not listed there default to Sonnet high (`CLAUDE_APPLICATION_MODEL`/`EFFORT` in `claudeApplicationRunner.js`).
- Live calls: `electron/interviewAiMatcher.js` (Listen matcher) and `electron/practiceCall/callService.js` (practice call opener, main reply, classifier).
- DeepSeek routing: `electron/ipc/aiCallProviders.js`, measured in `docs/application-improvement-sessions.md` (Hard rules).

## Policy

**Hard exclusions.** Never use `max` effort, for Claude or for DeepSeek reasoning. Never use Fable. Always use the latest model: the Claude family alias (`haiku`, `sonnet`, `opus`) resolves to the newest model, and DeepSeek uses the newest Flash and Pro the provider maintains. Never test or pin an older version.

**Candidate models.** Every ladder for a call that is not live includes the latest **DeepSeek Flash** and **DeepSeek Pro** next to Claude Haiku, Sonnet and Opus. Each DeepSeek model is tested with reasoning off and with reasoning on at low, medium and high effort; only `max` reasoning is excluded. DeepSeek is usually by far the cheapest (Flash with reasoning off cost about $0.001 a call on requirements-audit, against $0.058 for Claude), so it sits at the bottom of the cost order and is tried first. It runs through `electron/ipc/aiCallProviders.js` routes (`deepseek-flash`, `deepseek-pro`) and `offloadTextCall`. A DeepSeek route needs Offload credit; when credit runs out the call falls back to Claude, so a DeepSeek winner also needs its Claude fallback setting chosen. Limits measured 2026-11-07: the app caps DeepSeek output at 32k tokens, so reasoning settings truncate long answers, and web research only works through Offload's built-in `web_search`/`web_fetch` (`webTools`). Calls that use tools other than web search, page images, or truth checks (fact-check stages, `qa-research`) are not routed to DeepSeek. Live calls also include DeepSeek in their speed tests: the 2026-11-07 Listen-matcher test found Flash slower than Opus medium.

**Calls that are not live** (everything except the calls that run while a practice or real interview is happening): use the cheapest setting whose quality is within noise of the best setting tested. Find it like this:

1. Order candidate settings by **measured** cost per call, cheapest first. Do not assume model-tier order: on input-heavy prompts Sonnet low cost about the same as Opus xhigh (editorial planner, 2026-11-09).
2. Test the cheapest setting on the hardest few real prompts first. Pass means: the app's own validator accepts it at about the production first-try rate, and a blind judge (or planted defects, for audits) finds it within noise of the reference.
3. Stop climbing at the first setting that passes, and confirm it on all captured prompts with a second run. If the confirmation fails, go up one step.
4. A setting that needs more retries counts its retry cost. Generation time is not a criterion.
5. Measure the noise floor: run the reference setting twice, or include an unchanged rerun as a control arm. A gap smaller than that is not a difference.
6. For a stage whose output feeds another stage (planner to writer, compile to audits), judge the downstream result too, not only the stage's own output.
7. **Value of information.** Measuring has a cost too. When a call's whole annualized spend is below what a ladder would cost (about $20), it cannot repay the test even if a cheaper setting won. Then keep the current setting and record it as **Settled by cost bound**, with the annualized spend. Annualize from `claude-task-usage.jsonl` (background tasks) or the `claude-runs` logs (application stages). A call already at the cheapest setting that exists (Haiku low) is settled the same way. Re-check the bound when usage grows, for example when a rarely used feature becomes a daily one.

**Live calls** (practice-call opener, main reply and classifier; the Listen matcher during a real interview): use the fastest setting, measured by p95 first-word or first-sentence time under realistic load, among settings that meet the call's quality floor (rule-following or correctness measured on real cases). A setting that is faster but breaks the call's rules is not eligible. When the speed difference is insignificant but the quality loss is significant, choose the better-quality setting (the user's rule, 2026-11-09). "Insignificant" means within run-to-run timing noise or a small fraction of the call's latency budget; for example 0.2 s at p95 on a 2 s reply.

**Re-test triggers:** a new model release in a family, a changed prompt or schema for that call, a changed validator, a new candidate provider (for example DeepSeek), or a production signal (quality drift, rising retries). Otherwise reuse the results below.

**Results are tied to model versions.** The app always calls the latest alias, but every result here was measured on a specific version, listed under Model versions tested. When a newer version of any family is released, the earlier results for that family are history. A call whose ladder included that family gets a new assessment on the new version; do not assume the old ranking carries over. Calls whose ladder never involved that family are unaffected. Record the resolved model id with every new result. The Claude stage runners return it as `model`, and the ladder tools write it to each result row.

## Model versions tested

| Date | Claude | DeepSeek | Covers |
|---|---|---|---|
| 2026-11-09 | `claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5` (ids recorded in every result row) | none run | Every 2026-11-09 result in this file |
| 2026-11-07 | `claude-*-5-5` baselines | alias `deepseek-flash` / `deepseek-pro`; Offload price table `deepseek-2026-10-01`; the provider's exact version id was not logged | DeepSeek results table |
| 2026-11-01 / 2026-11-02 | Not recorded in surviving data; production usage logs from 2026-11-05 show the 5.5 family | none | Partial rows and the 2026-11-01 stage results |
| Earlier (live calls: matcher, practice call) | See `docs/interview-live-ai-matching.md` and `docs/interview-practice-call.md` | Flash (matcher, 2026-11-07) | Live table |

## How to measure

**Every run records itself as it goes (rule since 2026-11-10).** On 2026-11-09 a session ran out of usage mid-ladder and was then deleted; its result rows lived only in the session scratchpad, so measured pick results were lost. Now:

- Each test tool writes its run to [`docs/ai-test-runs.md`](ai-test-runs.md) when it starts, rewrites it as results land (at most once a minute, at once on milestones such as a finished bundle), and marks it interrupted on SIGINT/SIGTERM or an early exit. The section holds counts, validity, cost and agreement only, never prompts or answers. This happens whether or not a decision has been made; that file is the raw evidence and this one holds the conclusions. Covered: `claude-effort-ladder.mjs run` and `capture-career`, `ai-task-replay.mjs`, `web-research-ab.mjs` and the live bundle harness `scripts/live-bundle-harness.mjs` (moved out of the git-ignored `tmp/` on 2026-11-10; the old path forwards to it) (`scripts/ai-test-journal.mjs`).
- `--out` must be durable. The tools refuse a session scratchpad, a Claude Code session temp folder or the OS temp folder; use `~/Library/Application Support/infinite-canvas/ai-test-runs/<name>` (or `tmp/claude-e2e/runs/<name>` for the live harness). `--ephemeral` skips both the check and the run log, for throwaway runs only. The live harness also copies its `--job` inputs into `<out>/inputs/`, so a run never depends on files in a scratchpad.
- When a run ends, copy its numbers into the call's row below with a link to its run-log section, even when the result is partial.
- A result no tool recorded itself (a blind-judge pass, a hand comparison, a number read off a transcript) goes in the run log at once with `node scripts/ai-test-journal.mjs record --tool <name> --task <call> --row "arm|n|valid|failed|cost|notes" [--fact Key=Value] [--note ...] [--out <durable dir>]`. Keep its inputs and scripts in that durable dir, never only in a session scratchpad.

- `scripts/claude-effort-ladder.mjs`:
  - `capture-editorial` captures archived planner prompts.
  - `run` replays stored records at any `model:effort` list.
  - `capture-career` runs the real career compile through the app's own code. It has `--baseline-from` (replay stored answers for free), `--live-on-miss`, `--max-repairs`, `--only-records`, and `--profile-override task=model:effort` (one task at a different setting, run to convergence).
  - `summarize` prints per-setting validity and cost. Output dirs must be outside the repo.
- `scripts/interview-live-prepare-harness.mjs --research-profile model:effort` runs interview research at a given setting. Since 2026-11-09 the CLI runner returns `costUsd`/`usage`, so cost is recorded.
- `scripts/ai-task-replay.mjs`: offline replay of background tasks on stored board rows. `--configs` takes `claude` (the production baseline; `--claude-reps` sets the noise floor), `claude:<model>:<effort>` (added 2026-11-09), `flash:<reasoning>` and `pro:<reasoning>`, so one run can ladder Claude and DeepSeek together. Rows come from a canvas file with a scored board; the 2026-11-04 backup `canvas.json.before-content-pool-2026-11-04.bak` holds 569 scored rows. `scripts/ai-task-replay-score.mjs --out <dir>` scores validity, agreement with Claude rep 1 and cost.
- DeepSeek for application stages: replay archived prompts through `offloadTextCall` (the 2026-11-07 method in `docs/application-improvement-sessions.md`), or measure live with shadow mode (`INFINITE_CANVAS_SHADOW_OFFLOAD`, `scripts/ai-shadow-report.mjs`).
- Live: `scripts/interview-match-benchmark.mjs`, `scripts/interview-practice-benchmark.mjs`.
- Planted-defect audits: insert known defects into captured prompts, then count catches per setting, with the current setting as the reference.
- `scripts/web-research-ab.mjs --profile model:effort` runs the preference, compensation, role-family and location web-research tasks at any setting, with prompts rebuilt from a canvas file (2026-11-09). Use the same `--seed` and `--count` as the reference run, and compare the `native` arm per check. Do not use `ai-task-replay.mjs` for these tasks.
- `capture-stage --stage <name>` (in `claude-effort-ladder.mjs`) captures archived application-stage prompts for any stage from `claude-runs`. It covers fresh-session stages only. Stages that always resume a session (verify-correction, fit-correction) and stages that read page images (pick) cannot be replayed from logs.

**Recording for the next assessment (added 2026-11-09).** Every Claude call now leaves data that the next model release can be measured against without a new capture:

- `<userData>/ai-replay-samples/<task>/` holds the newest 24 prompts per task (owner-only). Each file includes the system text, the answer, the resolved model, effort, cost, usage, duration and the validator outcome. It covers background tasks and the interview stages. Turn the files into `claude-effort-ladder.mjs run` records by mapping `{id: <file name>, task, text, systemAppend}`. The ladder's default validator then applies the app's schema or planner checks; compare answers against the stored `answer`. This is the route for calls that had no replay tool: location consolidation, compensation assessment, gap review, repair, the career audits and the interview stages.
- `claude-task-usage.jsonl` gets one row per call with the resolved model id, so every result can name the version it ran on.
- `node scripts/ai-spend-report.mjs --user-data <userData> --runs-dir <canvas>/.local-ai/claude-runs` prints the annualized spend of every call, for the value-of-information rule (step 7). It annualizes over each log's whole span, not each call's own active days. A call used in bursts would otherwise look 4–6× too expensive. Application stages logged cost only from 2026-11-05 on, so their spend is the mean recorded cost × all logged calls, marked "estimated".

## Results by call

Status:

- **Proven**: tested from the cheapest plausible setting upward, or the setting is already the cheapest that exists (Haiku low), with results recorded here.
- **Partial**: some settings tested, but not from the bottom, or the numbers were not recorded.
- **Untested**: never measured.
- **Settled by cost bound**: annual spend is below what a ladder would cost (policy step 7), so the setting stays without a test.

### Career data pipeline

| Call | Current | Status | Evidence |
|---|---|---|---|
| `career-profile-compile` | Opus xhigh | Proven (2026-11-09) | 3 real page prompts at production. Opus low and Opus medium were valid on all 3 pages, Haiku medium and Sonnet medium on 2, Opus high on 1. Every setting below xhigh classified 35–55% fewer of the technology labels the instructions require (page 2: xhigh 65 references, others 29–53), and a blind judge rated xhigh clearly better on the dense page. Cost at xhigh was $0.17–0.97 a page. Keep xhigh; there is nothing higher to test. One career file only. |
| `career-profile-audit-skills` | **Haiku medium** (applied 2026-11-09; was Opus xhigh) | Proven (2026-11-09) | 9 planted defects (fabricated skill, soft skill flipped to indexable, literal label dropped; 3 prompts × 2 runs). Haiku low caught 17/18; Haiku medium, Haiku high, Sonnet medium and Opus xhigh each caught 16/18. On 6 real prompts Haiku low was valid 12/12 and Haiku medium 6/6, while xhigh needed retries on 2/6. Cost a call: Haiku low $0.010, Haiku medium $0.012, Opus xhigh about $0.38–0.50. Opus low found no real findings at all. Downstream, a full compile run to convergence (page compiles replayed, every other task at production): with this audit on Haiku medium it was approved in 2 rounds (skills $0.13 for 12 calls). On Haiku low it did not converge: after 3 rounds a repair failed 6 times in a row with "proposes no change", because the audit asked for fixes that were already in place. So Haiku low fails downstream, and Haiku medium is the cheapest setting that passes. |
| `career-profile-audit-completeness`, `-grounding`, `-attribution`, `-metrics`, `-conflicts` | Haiku medium | Settled by cost bound (2026-11-09) | $7.50–10.70 a year each (spend report, 6.5-day usage log). The only cheaper setting, Haiku low, would save about $2 a year per audit. On the skills audit, Haiku low also stalled the compile. Seeded-defect test 2026-11-02; numbers not recorded. |
| `career-profile-clean` | Haiku low | Proven (floor) | Cheapest setting that exists. |
| `career-profile-repair` | Sonnet low | Partial (2026-11-02); measurable from replay samples | About $42 a year. Numbers not recorded; Haiku not recorded as tested. It was rejected 3 times in a row once (2026-11-09) before passing, so watch retry cost. A Haiku ladder costs a few dollars once `ai-replay-samples/career-profile-repair/` has prompts. |

### Job search and marketplace (background tasks)

Every setting below came from the 2026-11-02 test: "each is the cheapest setting where blind judges found no material loss against Opus xhigh, or, for the audits, where seeded defects were still caught" (comment in `claudeTaskProfiles.js`). Per-task numbers and the settings tried were not recorded, except where noted.

The raw results cannot be recovered; searched on 2026-11-09. The session that ran these tests (d1866bc6) and its scratchpad are deleted. Its leftover Claude CLI folders under `~/.claude/projects/*d1866bc6*` hold only web pages downloaded by research tasks and a few single-call transcripts, with no judging or scores. Later sessions quote only the code comments. Folder names in `/private/tmp/claude-501/` show which application-stage arms ran on 2026-11-01: write low/medium, plan low/medium/Sonnet, requirements medium, convert higher, corrections lower, fact Opus/Sonnet, and cached/uncached bundles. No scores survive beyond those already in the 2026-11-01 log of `docs/application-improvement-sessions.md`. The Partial calls must therefore be re-measured.

| Call | Current | Status |
|---|---|---|
| `job-role-screen-batch`, `job-taxonomy-plan`, `job-listing-liveness`, `platform-fit-assessment`, `marketplace-hub-scan-batch`, `career-profile-clean` | Haiku low | Proven (floor). `marketplace-hub-scan-batch` was tested on made-up inputs. |
| `job-preference-interpretation`, `application-edit-recurrence` | Haiku medium | Settled by cost bound (2026-11-09): under $1 a year each. |
| `price-synthesis-batch` | Sonnet low | Settled by cost bound (2026-11-09): no calls in the usage log. Tested 2026-11-02 on made-up marketplace inputs. Re-check if the marketplace modules come back into daily use. |
| `job-role-audit`, `job-taxonomy-classify-batch` | Sonnet medium | Settled by cost bound (2026-11-09): $0.37 a year and no calls. |
| `job-official-posting-match` | Sonnet medium + web | Proven. Largest spend of any call: about $19,900 a year (2,319 calls in 6.5 days). 2026-11-02: 8 real postings × 2 runs; Sonnet medium passed 16/16 at the lowest cost among settings that matched Opus xhigh (15/16); Haiku failed 3–4/16, Sonnet low 1/16. 2026-11-09 re-test (`ai-task-replay.mjs`, 16 batches with live page downloads, production run twice): production was valid 96.9% with 100% decision and chosen-lead agreement between its own runs, at $0.203 a call. Sonnet low was valid 87.5% (4 of 32 invalid, each a retry) with 96.4% decision and lead agreement, at $0.156; about 12% cheaper after retries, at the cost of more rejections and a wrong match. Haiku high was valid 100% but only 68.8% decision and 78.1% lead agreement, at $0.062. DeepSeek failed on 2026-11-07. Sonnet medium stays. |
| `job-preference-evaluation` | **Sonnet low** (applied 2026-11-09; was Sonnet high) | Proven (2026-11-09). Replay of the 2026-11-04 board, with production run twice as the noise floor (outcome 88.9%, decision 96.8% agreement). Tier 1, 3 batches: Haiku low, medium and high scored 70.7–78.7% outcome and 82.7–85.3% decision agreement, clearly worse; Sonnet low scored 91.5% / 96.0%. Confirmed on 6 batches × 2 runs: Sonnet low 87.7% / 98.0%, within noise, valid 10/12 vs 11/12, at $0.386 vs $0.497 a call (about $0.46 vs $0.54 counting retries). DeepSeek failed on 2026-11-07. |
| `job-gap-review`, `job-preference-research-batch-assessment` | Sonnet high | Partial; measurable from replay samples. About $38 and $44 a year. A ladder costs a few dollars once `ai-replay-samples/` holds their prompts after the next board run. The assessment rode along in every preference-research run on 2026-11-09 at $0.6–1.8 a run, but it was never laddered on its own. |
| `job-scoring` | Opus low | Proven (2026-11-09). Replay, 3 batches of 44 jobs; production valid 5/6, and 89.5% of scores within 5 points between production runs. Every cheaper setting failed: Haiku low 0/3 valid; Haiku medium, Haiku high and Sonnet low 1/3 (34%, 47% and 9% within 5); Sonnet medium and Sonnet high 2/3 (55% and 68%). Opus low is the lowest Opus effort. Production costs $1.16 a call. DeepSeek failed on 2026-11-07. |
| `job-official-posting-research` | Opus low + web | Proven (2026-11-09). Replay; production run twice. Tier 1 and 2, 3 batches: every setting found fewer official postings than production (50%): Haiku low 33%, Haiku medium 39%, Haiku high 44%, Sonnet low 19%, Sonnet medium 42%. Sonnet high found 56% but cost $1.57 vs $0.83. Sonnet medium confirmed on 6 batches × 2 runs and failed: 65.3% agreement and 47.9% found, vs 77.8% and 62.5% between production runs; production found 23 postings it missed. DeepSeek failed on 2026-11-07. |
| `job-compensation-assessment-batch`, `job-location-consolidation-confirmation` | Opus low | Partial; next to measure (about $370 and $509 a year). No replay tool existed. Since 2026-11-09 the app records their prompts in `ai-replay-samples/`; after the next board run, ladder them with `claude-effort-ladder.mjs run` from Haiku low up, with Opus low run twice as the noise floor. |
| `job-compensation-research-batch` | **Sonnet medium** + web, built-in search and Tavily merged (applied 2026-11-09; was Opus medium) | Proven (2026-11-09) with `scripts/web-research-ab.mjs --task compensation --seed 3 --count 12` (new `--profile` option) on the 2026-11-04 backup. The tool rebuilds the cohort prompts from the board, so no capture was needed; `ai-task-replay.mjs` still cannot replay this task. Merged answer per setting, for 12 cohorts: cohorts with 2+ verified sites / verified sources (cap 5 per cohort) / research cost. Production, 2 runs: 9–10 / 46, 46 / $15.37–17.20. Haiku low: 5 / 18 / $0.58. Haiku medium: 5 / 23 / $1.12. Sonnet low: 10 / 32 / $2.16. **Sonnet medium, 2 runs: 10–11 / 36–39 / $3.66–4.25.** Sonnet high: 10 / 41 / $11.28. Opus low: 4 / 20 / $4.72. Sonnet medium matches production on the two-source coverage the salary verdict needs, at about 75% less cost. It finds about 20% fewer verified sources, so bands rest on 3–4 sources instead of 4–5; that is the trade-off taken. Its built-in-search arm often wraps sections in prose (3 and 5 of 6 replies rejected by the parser), but the merged answer was valid every time, so it adds no retries. Each step up buys only a few sources at a much higher price. |
| `bundle-price-synthesis` | Opus medium | Settled by cost bound (2026-11-09): no calls in the usage log. |
| `job-preference-research-batch` | Opus medium + web | Proven (2026-11-09). About $346 a year. Measured with `web-research-ab.mjs --task preference --count 40 --seed 3 --profile <setting>` on the 2026-11-04 backup (45 jobs, 180 preference checks), comparing the `native` arm per check with the production run of 2026-11-09. Noise floor: two Opus medium runs agreed on 96.5% of checks, with 4–6 left unconfirmed each. Results (confirmed / conflicts / unconfirmed, research cost): Haiku medium 31 / 0 / 149, $1.78; it missed both real conflicts, so 2 agencies would pass the filter. Sonnet low produced no valid answers, $2.15. Opus low 71 / 2 / 107, $3.43. Sonnet medium 163 / 2 / 15, $3.82, 93.6% agreement. Sonnet high 157 / 2 / 13 (172 checks returned), 93.6% agreement. Production 174 / 2 / 4, $12.35. Sonnet medium and Sonnet high made the same filter decisions, but each left 2–3× as many strict checks unconfirmed. On the card, an unconfirmed check reads "could not be confirmed" and lets the job through, for example a possible agency. Going from medium to high did not close that gap, so no Sonnet setting reaches Opus medium. Keep Opus medium; the most a cheaper setting could save is about $240 a year. |
| `job-query-generation`, `vision-product-analysis` | Sonnet medium | Settled by cost bound (2026-11-09): no calls in the usage log (rare, and no product photos were available). |

### Application generation

The 2026-11-01 entry in `docs/application-improvement-sessions.md` holds the stage numbers.

| Stage | Current | Status | Evidence |
|---|---|---|---|
| `requirements` | Sonnet high (default) | Partial; Haiku medium promising (2026-11-09 live arm, interrupted), not yet judged (about $900 a year) | Live arm `requirements=haiku:medium` (see [run log](ai-test-runs.md)): ran on all 12 jobs, 74/78 replies accepted vs 85/85 in the two production arms, at $0.022 a call vs about $0.25; 3 bundles finished (Appian, Stripe, Leap Tools). It hit no safeguard refusal, while production Sonnet high was refused on 4 jobs across the arms. Next: judge its requirement sets against both production runs, then Haiku low on 4 jobs. 2026-11-01: lower settings "saved too little to risk", without numbers. 2026-11-04: Opus avoids rare safeguard refusals but was reverted on cost; a refused stage offers Upgrade to Opus. |
| `requirements-audit` | DeepSeek Flash, reasoning off | Proven (2026-11-07 routing test) | Live on Flash since 2026-11-08; before that the logs show Sonnet at $0.067 a call. |
| `requirements-adjudication` | Sonnet high (default) | Settled by cost bound (2026-11-09) | About $13 a year. DeepSeek rejected; cheaper Claude settings not recorded. |
| `editorial-plan` | Opus xhigh | Proven (2026-11-01, 2026-11-09) | About $1,020 a year (spend report: 177 calls in 17.7 days at a mean of $0.28; corrected 2026-11-09 from a $312 estimate that divided 5 costed days by the whole span). Outline validity on 8 real prompts: Haiku low and Haiku medium failed the planner validator (miscopied catalog IDs; medium 12/16 valid); Haiku high was valid 31/32 across both rounds; Opus low and Opus medium were valid on all of theirs. Outlines judged alone, Haiku high tied xhigh 2–2. Judged downstream instead: outline swapped into the archived writer prompt, letter drafted by the production writer (Opus low), and blind judges ranking letters per job against a control that reran the unchanged xhigh outline through the same SDK harness. Compare to that control only: the letters already generated in production ran through the CLI and ranked about a full place higher in the same panel, a harness artifact rather than an outline effect. Results: 8 jobs, 3-way: Haiku high 2.25 vs control 2.00. 8 jobs, 4-way: Opus medium 2.75, Opus low 3.00, control 2.63. 15 new jobs, 3-way, judged by DeepSeek Flash report jobs: control 1.73 (8 firsts), Haiku high 2.00, Opus low 2.27 (7 lasts); total scores 116 / 113 / 110. Across 23 jobs every cheaper outline setting trailed the xhigh control, consistently if slightly, so the reasoning shows up in the letters. Under production caching an outline costs about $0.28 at xhigh against about $0.10 at Opus low and $0.026 at Haiku high. Keep xhigh: letters are the product, and the most a cheaper outline could save is about $650 a year. 2026-11-01: Opus low (65.7) and Opus medium (65.1) plans scored within noise of xhigh (66.7) on final bundles; the larger 2026-11-09 letter test supersedes it. |
| `write` | Opus low | Proven (2026-11-01) | Opus low +1.1 vs xhigh; Sonnet high −3.9 and Sonnet xhigh −3.8, so cheaper settings lose. Haiku was not tested, but it sits below Sonnet, which already failed. |
| `pick` | Opus high | Partial (2026-11-09); offline from the evidence archive | Replayable offline since 2026-11-09: `capture-archive --stage pick` reads the 64 archived prompts with their page images, and `summarize --records` scores top-1 agreement with the archived production answer. Five-candidate prompts, numbers as reported (raw rows lost, see [run log](ai-test-runs.md)): 8 prompts: Haiku low/medium 12–25% invalid and 33–43% agreement, Sonnet low 3/8, Sonnet medium 5/8 at about half the cost, production rerun 69%. 24 more: Sonnet medium 48% vs a production rerun's 83%, so Sonnet medium fails. Opus low and Sonnet high on those 24: result lost; rerun with a production arm. |
| `convert` | Sonnet medium | Partial; Haiku medium likely fails (2026-11-09 live arm, interrupted) | Live arm `convert=haiku:medium` (see [run log](ai-test-runs.md)): 0 of 12 bundles finished in 45 minutes while production arms finished several; 14 of 24 Haiku convert replies broke hard contracts (5–6 evidenceIds per paragraph, unknown IDs, a technology named as employer) against about 2 in 110 production replies. Next rung: Haiku high on 4 jobs. |
| `verify-correction`, `fit-correction` | Sonnet high | Partial; the 2026-11-09 Haiku medium 4-job arm gave no usable result (2 jobs lost to the production requirements safeguard, 5 verify and 1 fit calls ran; see [run log](ai-test-runs.md)). Needs a paired live test (about $1,600 and $745 a year, the largest application stages) | Kept 2026-11-01; cheaper settings not recorded. Both always resume the writer's session, so only a live bundle run can test them. |
| `fact-check`, `fact-correction`, `fact-recheck` | Opus high | Proven (2026-11-01) | Seeded false claims: Haiku low caught 12/18; Sonnet high and Opus high caught every subtle one. Opus also flagged real ownership overstatements that Sonnet passed ($0.06 vs $0.02 a call). Haiku medium/high were not tried, but Haiku low's misses and the truth-check role make this low priority. |

### Interview helper (not live)

Cost bound for the interview stages (2026-11-09): the Q&A has run 4 preparations in total, each a few Opus calls costing well under $1, so qa-brief, qa-write and qa-practice-review together cost a few dollars a year. That is below the price of a ladder. Since 2026-11-09 each attempt is recorded in `ai-replay-samples/` and `claude-task-usage.jsonl`. Re-check with the spend report if interview prep becomes a daily habit.

| Stage | Current | Status | Evidence |
|---|---|---|---|
| `qa-research` | **Opus high** (applied 2026-11-09; was Opus xhigh) | Proven (2026-11-09) | Blind judges, Fieldguide bundle: two Opus xhigh runs scored 43 and 41/50 (that 2-point gap is the noise floor), Opus high 40. Opus medium 33, Sonnet high 33, Haiku high 31, Sonnet low 30, Opus low 29, Sonnet medium 28; Haiku low was far thinner (6 sources vs 18). Pairwise confirmation: Appian xhigh slightly better, Reddit Opus high slightly better. Opus high costs $0.38–0.59 vs $0.66–0.84 for xhigh (18–47% less). Sonnet xhigh averages $0.50 vs Opus high's $0.47, so it cannot be the cheaper choice. |
| `qa-brief` | Opus medium | Settled by cost bound (2026-11-09) | Order planning measured: effort made no difference and Opus was fastest. Cheaper models' cost and quality not recorded. |
| `qa-write` | Opus medium | Settled by cost bound (2026-11-09) | Set apart from the application writer "until tested". |
| `qa-practice-review` (post-call review, `practiceCall/analysis/analyzeCall.js`) | Opus medium | Settled by cost bound (2026-11-09) | Same profile as qa-brief by assumption. |
| `qa-fact-check` / `-correction` / `-recheck` | Opus high | Proven by sharing | Same prompts and code as the application fact stages. |

### Live calls (fastest that meets the quality floor)

| Call | Current | Status | Evidence |
|---|---|---|---|
| Listen matcher (real interviews) | Opus medium, warm, pool of 4 | Proven (`docs/interview-live-ai-matching.md`) | Fastest everywhere (p50 about 0.93 s, p95 1.0–1.18 s, quiet and loaded) with quality tied. Low was no faster; Sonnet and Haiku were worse. DeepSeek Flash was slower (p50 1.39 s). |
| Practice call opener | Opus low, warm CLI | Proven (`docs/interview-practice-call.md`) | First word p95 1.17 s with 34/34 rule-following. CLI Haiku low 1.89 s (3/34). API Haiku with thinking off was faster (p95 0.82 s) but broke the rules (11/34). |
| Practice call main reply | Opus low | Proven | First sentence p95 2.04 s at 83.1% blind quality. Haiku low was faster only by an insignificant margin (p95 1.86 s, p50 1347 vs 1398 ms) and lost 6 quality points (77.0%), so Opus low stays under the speed-vs-quality rule. |
| Practice call classifier | Opus low | Proven | Every setting 100% accurate on 48 cases; Opus low had the fastest p95 (1087 ms). |

### DeepSeek results per call (2026-11-07)

Measured with Flash and Pro at reasoning off through max (max is now excluded), against Claude repeats as the noise floor. Full numbers are in `docs/application-improvement-sessions.md` (Hard rules).

| Call | DeepSeek outcome |
|---|---|
| `requirements-audit` | **Routed to Flash, reasoning off.** 14/14 accepted live; 98.4% agreement vs a Claude repeat of 99.2%; $0.001 vs $0.058 a call. |
| `requirements` | Failed. Quote relinking 33–75% vs 88% for Claude; after host fixes, live first-try 6/12 vs 5/5. |
| `requirements-adjudication` | Failed. 58–78% agreement vs 96%. |
| `convert`, `verify-correction`, `fit-correction` | Failed. Corrections accepted 1 of 15. |
| `job-scoring` | Failed. 0 of 36 answers passed the schema. |
| `job-preference-evaluation` | Failed. Best was Flash high: 12/12 valid but 69% outcome agreement vs 91%; the 32k cap truncates reasoning settings. |
| `job-official-posting-research` | Failed. At most 2 of 18 valid vs 17/18. |
| `job-preference-research-batch` | Failed. Pro off 4/6 valid, 56% agreement vs 74%. |
| `job-official-posting-match` | Failed. Flash high 73–76% first-try valid vs 87.5–97%; more corrections. |
| Listen matcher (live) | Failed on speed. Flash off p50 1.39 s vs Opus medium 0.98 s; reasoning settings slower still. |
| `job-compensation-research-batch` | Not measured. `scripts/web-research-ab.mjs` replays it, but it has no DeepSeek arm yet. |
| `qa-brief`, `qa-write` | Waiting for shadow-mode data. |
| Every other call | Not measured with DeepSeek. Include Flash and Pro when the call is re-measured. |

Re-test DeepSeek when a newer Flash or Pro is released, or when the app's DeepSeek output cap or Offload's web tools change.

## Open gaps (2026-11-09)

Every call is now Proven, Settled by cost bound, or one of the items below. Each item says what it needs.

1. **Application stages that only a live bundle run can test.** `verify-correction` (about $1,600 a year), `requirements` ($900), `fit-correction` ($745), `convert` ($600) and `pick` ($300), about $4,100 a year in total. Corrections always resume the writer's session, `pick` reads page images, and `requirements`/`convert` have no offline validator, so none can be replayed from logs. Method: a test-only stage-profile override honored only under `INFINITE_CANVAS_E2E=1`, then the live generation harness on about 10 real jobs. Production runs twice for the noise floor, then one stage at a time from its cheapest setting up, with blind judges on the final résumé and letter. Estimated cost: about $1.70 a bundle, so roughly $150–250 of Claude for 5 stages (cheapest-first usually stops after 1–2 rungs), plus about 7 hours of wall time. It needs the user's go-ahead.
2. **Calls measurable from the new replay samples** once the app has run with recording on (any board run or career compile after 2026-11-09): `job-location-consolidation-confirmation` ($509), `job-compensation-assessment-batch` ($370), `job-gap-review` ($38), `job-preference-research-batch-assessment` ($44) and `career-profile-repair` ($42). Method under How to measure (recording). Each ladder costs a few dollars.
3. **Applied 2026-11-09:** `career-profile-audit-skills` → Haiku medium, `qa-research` → Opus high, `job-preference-evaluation` → Sonnet low, `job-compensation-research-batch` → Sonnet medium. Each has a comment in its profile table pointing here.

## Log

### 2026-11-09 — the four Opus xhigh calls

Tested cheapest-first after the user questioned xhigh on `career-profile-audit-skills`. The production xhigh answers served as free baselines, and the judges were blind (DeepSeek Flash report jobs for outlines, research and compile; Sonnet subagents for letters). Results are in the tables above. Claude spend was about $40 at list price. Two diagnostic fixes shipped alongside:

- **Career-compile records in the bug report:** they were hidden unless a job search had run in the same process (`getJobsCareerCompilationForReport`).
- **CLI runner cost:** it dropped `costUsd`/`usage` (`parseClaudeStreamOutput`).

### 2026-11-09 — closing the gaps

- **Preference research:** Opus medium stays (see its row). Ladder cost about $15.
- **Spend report fixed.** It annualized each call over its own active days, which overstated bursty calls 4–6×. It also only counted application stages since cost logging began on 2026-11-05, so its run-log window was 3 days. It now uses each log's whole span. Application stages cost about $6,500 a year in total, against about $49,000 for background tasks. The editorial planner is about $1,020 a year, not the $312 estimated earlier. Its verdict is unchanged.
- **Cost bounds recorded** for the small calls: the five career audits, preference interpretation, edit recurrence, role audit, taxonomy classify, price synthesis, bundle price synthesis, query generation, vision, requirements adjudication and the interview stages.
- **Recording added for the next model release:** `ai-replay-samples/`, resolved model ids in `claude-task-usage.jsonl`, cost and usage from the CLI runner, `capture-stage`, and the `--profile` option on `web-research-ab.mjs`.

