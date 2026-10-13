# Application acceptance — write then verify v2

The acceptance harness creates a disposable one-card canvas and queues one real v2 application against an already approved career snapshot. It does not change the user's source canvas or snapshot. Its run data, generated files, handoff archives and panel reviews stay under ignored `.test-artifacts/blackbox-run/` paths. The packaged app, production validators, renderer, PDFs and bridge are exercised for live acceptance.

## Protocol measured

Requirements extraction and audit run first, with binding adjudication and at most two re-epochs. The default is three independent candidates. Each candidate has a fresh write chat and a fresh convert chat; content and fit corrections remain in that candidate's convert chat. Content correction has a three-round cap, and measured one-page fit has a separate four-round cap. Every applicable truth and hygiene check runs unchanged. Accepted candidates are ranked by one blind judge handoff when there is more than one; the winner gets a fresh fact-check, with correction/recheck and ranked fallback if needed. The app then saves and renders the bundle. Rejected raw responses and exact check IDs are retained in ignored evidence.

A run's handoff count includes variable requirements pages and audit, two base handoffs per candidate, any content or fit corrections, a judge for multiple accepted candidates, and fact-check/recheck handoffs for ranked candidates attempted. No two candidates or stage roles share a fresh-chat key. The clean career-text sidecar is verified against original quotes; the original remains provenance. See `local_ai/PASTE_BACK_APPLICATION.md` for the stage contract and `electron/ipc/applicationV2Limits.js` for measured transport and prompt limits.

## Prepare and launch

First run the harness self-test. Use a unique run ID for each card. The harness prepares a run-scoped canvas and queued job; `launch` starts the signed packaged app on that canvas with the existing bridge configuration. The bridge worker uses its own fresh ChatGPT chats. Never delete or unpin conversations and never use bridge-wide revoke or turn-off controls.

```bash
node --import ./scripts/test-stubs/register.mjs .test-artifacts/blackbox-run/application-acceptance-harness.mjs self-test
node --import ./scripts/test-stubs/register.mjs .test-artifacts/blackbox-run/one-card-live-acceptance.mjs self-test
node --import ./scripts/test-stubs/register.mjs .test-artifacts/blackbox-run/one-card-live-acceptance.mjs prepare --run-id <unique-id> --card <card> --execute
node --import ./scripts/test-stubs/register.mjs .test-artifacts/blackbox-run/one-card-live-acceptance.mjs launch --run-id <unique-id> --execute
```

Use the bridge panel's **Copy worker starter** to attach a worker. Poll the run passively; inspect the manifest, generation log, and bridge status without submitting or altering a handoff. Close only worker tabs created for the run. Do not run a second live application before the first is terminal and restored.

## Inspect, score, restore

`inspect` is passive by default. `inspect --validate` invokes the production status reader and is for an intentionally active diagnostic check only. After a terminal saved receipt, collect `resume.txt`, `letter.txt`, both PDFs and page PNGs from the run's output bundle. Score against the frozen references in a single blind six-review panel using the same posting, hand, text, page PNGs and reversed order. Record total and per-dimension scores, truth and hygiene results, handoff count, wall-clock time, and every rejection by check ID.

```bash
node --import ./scripts/test-stubs/register.mjs .test-artifacts/blackbox-run/one-card-live-acceptance.mjs inspect --run-id <unique-id>
node --import ./scripts/test-stubs/register.mjs .test-artifacts/blackbox-run/one-card-live-acceptance.mjs restore --run-id <unique-id> --execute
```

Quit the packaged app before `restore`. The harness removes only its run-owned canvas, PDF bundle, `.local-ai` job and Application Sync entry after drift checks pass. Verify those four residues are absent. It does not rewrite the bridge lane store while the runtime may own it; the live bridge retires its own stale lane. If preparation failed after reservation and scoped rollback failed, use the harness's `recover --run-id <id> --execute` command after quitting the app, then inspect residue again. Never manually delete lanes from the user's bridge state.

## Offline simulator

`.test-artifacts/blackbox-run/offline-simulator.mjs` runs the same v2 host transitions in an isolated profile. It can initialize a synthetic career or a saved card's approved snapshot, serve handoffs through CLI or spool transport, and submit recorded responses. The simulator does not replace the packaged-app bridge acceptance: it cannot establish live ChatGPT delivery, page-image review, or actual wall-clock timing. Keep simulator and panel evidence in ignored run folders; tracked tests may contain only synthetic careers and postings.

## Local gates

Before final live acceptance, run `npm test`, `npm run lint`, the oracle leak gate (only `ngram` findings count), `npm run build`, and `codesign --verify --deep --strict` on the packaged app. A valid live pair requires both cards within five points of their references, zero confirmed hard truth claims, zero hygiene failures, and a green suite. Restore each run and verify residue before reporting completion.
