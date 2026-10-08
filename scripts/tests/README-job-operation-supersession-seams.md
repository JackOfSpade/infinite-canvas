# Job-operation supersession regression seams

The production handler currently has a pre-admission authority check in
`score-jobs`, but no injectable boundary between its pinned-snapshot read and
its first telemetry/snapshot/manual-handoff side effects. Tests can prove a
stale receipt is rejected before entry; they cannot deterministically pause at
that post-read boundary without monkey-patching module-private imports.

The minimal test-only seam is an optional dependency object accepted only by a
test registration helper (for example,
`__registerJobsHandlersForTests({ resolvePinnedScoringInput, beforeScoreSideEffect,
runScoreBatch })`). It must default to the existing production functions and
never be reachable through preload IPC. The adversarial test should:

1. Claim S1 and start score-jobs with a barrier immediately after
   `resolvePinnedScoringInput`.
2. Claim S2 while S1 waits at that barrier.
3. Release S1 and assert `operationSuperseded`, zero manual calls, no
   `scoring-progress`, no telemetry success, and no durable snapshot save.
4. Repeat with the barrier immediately before manual dispatch, then run an
   S2-current control proving one normal score still succeeds.

Fresh `search-jobs` has the analogous missing test boundary around provider
completion and the `recordSourcePage` / `markSourceStatus` /
`markProviderGathered` / `setStage` write sequence. A test-only provider
executor plus stage-write observer is needed to hold S1 after provider work,
claim S2, force a staging mutation false, and assert S1 returns a superseded
result rather than a successful search. The control must keep S1 current and
prove the same mutations complete successfully.

These are deliberately documented rather than implemented with a production
hook or brittle module-loader monkey patch while authority integration is in
flight. The source-shape/UI quiet-supersession regression is executable in
`job-diagnostics.js`.
