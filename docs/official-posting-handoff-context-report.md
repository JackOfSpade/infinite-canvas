# Official-posting batch admission failure — 2026-10-30

The reproduced root cause is loss of the originating IPC async context when a bridge-status publication drains the official-posting handoff queue. It happens before dock delivery and before durable admission. Leftover durable state is not required to produce the reported simultaneous round-1 judge-A `renderer-unavailable` failures.

## Failure path

`resolveOfficialPostingsByChat` subscribes its queue drain to bridge status. The bridge invokes subscribers synchronously in the publisher's async context. When a pool-capacity update releases waiting judges, the old drain called `cappedHandoff` in that context. `callLLMRaw` / `callLLMText` ultimately obtain sender, node and run identity from `getCurrentIpcRequestContext()`, not from the options passed by the posting service.

A publication outside IPC therefore reaches `requestNonApiAi` without a sender and throws `BRIDGE_RENDERER_UNAVAILABLE` immediately. A publication from another invoke can instead give the waiting work that invoke's sender, node and durable run identity. The earlier dock retry fix cannot protect either case: no registry request has been admitted yet.

The new regression starts five rows with one active A judgment and four A judgments waiting for pool capacity. Publishing capacity from outside IPC reproduces four failures in one burst. A negative control that disables only the new context binding recorded all four at the same synthetic timestamp (`2026-10-30T13:59:35.322Z`), each with `round: 1`, `run: "A"`, `route: "mcp"`, `manualRoutingReason: null`, and `failure: "renderer-unavailable"`. Those four never attempted a dock send. Publishing from a foreign IPC context instead delivered exactly four handoffs to the foreign sender. Both negative controls fail the new assertions.

Stable queue membership can make the same rows recur across runs: the requests waiting when capacity is published fail together. The reproduction does not depend on random delivery loss, dock interaction, a manual fallback, or row-specific durable state. The prohibited live application-data directory was not inspected, so this report establishes the source mechanism and matching synthetic failure signature rather than claiming access to additional live traces.

## Durable-state investigation

Durable keys hash the materialized logical prompt, task, node, batch, item count and attachment identity. Lookup reads only `runs[manualAiRunId].steps[stepKey]`. Live adoption separately keys its owner by `[manualAiRunId, stepKey]`. Comparison group identity alone does not select another run's durable record.

The cross-run regression uses real official-posting judge prompts and schemas to leave a failed comparison, a corrected then aborted pending step, and an exhausted requeue step. It also seeds a legacy predecessor with a draft, escalation, mismatched group, manual proof, invalid-count exhaustion, correction and future retry deadline. A new run then issues the same four logical step keys while every initial dock send throws. All four remain MCP-routable, accept fresh worker provenance, and complete; the old run remains byte-identical. A second regression keeps an old live requeued/adopted request alongside the same step in a new run and proves independent request/code ownership. These isolation tests pass without the dispatch fix.

Within comparative admission, a restored state that would select manual routing is rejected with the comparative error before the manual renderer check. That also distinguishes the suspected draft/escalation path from the supplied `BRIDGE_RENDERER_UNAVAILABLE` signature.

## Changes

- Bind `cappedHandoff` to the enqueueing async context for each queued item with `AsyncLocalStorage.bind`. Status publications, polls and completion callbacks can release work while retaining its original sender, node and run identity.
- Report routing through a main-only callback across issuance, durable replay, live adoption and later manual escalation. Both successful and failed judgment entries contain `route` and `manualRoutingReason`. Manual reasons are code-owned values: `attachment`, `unreviewed-task`, `unsupported-response-format`, `initial-response`, `restored-draft`, `rejection_cap`, or `worker_restart_cap`.
- Prepare the private posting-store directory before writing a judgment log, including a forced first refresh that skipped cache reads.
- Retain the existing dock retry behavior. A new test verifies that a transient first manual send failure automatically retries the same request and code without settling its promise. The context regressions deliberately fail all four initial dock sends after capacity growth, then complete all ten A/B judgments through the worker registry.

The three new test files are registered in `scripts/test-runner.js`. No durable schema migration, deletion of predecessor work, or changes to same-run recovery semantics are needed.

## Validation

The final direct Node sweep passed **103 suites, 2,963 tests, zero failures**: every `official-posting*`, `handoff-bridge*`, `non-api-ai*` and `job-board*` suite, plus IPC coverage in `electron-regressions`, `handoff-bridge-ipc`, `solve-ipc-failure`, `job-diagnostics` and the operation-ledger suites, and the LLM/model suite. New coverage consists of nine cases in the three new files and one judgment-log case in `official-posting-chat-engine.js`. The two context regressions also detect removal of the fix in the separate negative-control process.

All suites used `scripts/test-stubs/register.mjs`, an unexpected-network guard and process-private temporary user data. Authority-ledger fixtures used the existing process-identity test hook for the sandbox's `/bin/ps` restriction. The final sweep ran against the completed source; an earlier in-flight sweep had loaded the pre-fix log-directory implementation and failed the two new log-count assertions. The completed implementation passes both assertions and the full sweep.

`npm run lint`, `node --check scripts/test-runner.js`, and `git diff --check` passed. Existing uncommitted work was retained. No interview files were edited, no commit or app/Electron launch occurred, and neither prohibited real-data directory was accessed.
