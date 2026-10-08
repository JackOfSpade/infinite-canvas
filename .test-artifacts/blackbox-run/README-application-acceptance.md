# Local-AI application acceptance harness

`application-acceptance-harness.mjs` is a guarded, disposable driver. It uses
the production career-snapshot and Local-AI queue exports under the Electron
test stub; it does not generate text, validate a result, render PDFs, or save
an application bundle itself.

## Disposable one-card live acceptance fixture

For one real paste job without ever writing the production canvas,
pre-existing `.local-ai` state, existing bundles, or the source snapshot, use
`one-card-live-acceptance.mjs`. It recursively copies exactly the saved
Anthropic job-9 or Affirm job-13 into a new one-card canvas below
`.test-artifacts/blackbox-run/live-one-card`, then deterministically derives
the only eligible snapshot address from the current `Work Experience.md` bytes,
its filename, and the current compilation contract. It uses only the strict
current-contract reader at that address — it never selects by timestamp,
directory scan, or historical-pin fallback — and requires one exact direct
`Work Experience.md` source record with matching text and hashes. It never
publishes a snapshot. A source, contract, snapshot, or in-read byte drift
fails closed. The queue then uses that attested immutable ID against the
run-owned canvas. The queued job's canvas path/root and all bundle candidates
remain run-owned. The harness deliberately uses the real Infinite Canvas
user-data so the existing bridge, OAuth, tunnel, and plugin setup is available;
while active, it creates only the run-scoped authority/job/Application Sync
entries recorded in its manifest, and `restore` removes those exact entries
only after its drift checks pass.

```bash
node --import ./scripts/test-stubs/register.mjs \
  .test-artifacts/blackbox-run/one-card-live-acceptance.mjs prepare \
  --run-id live-YYYYMMDD --card anthropic --execute
```

The command reports the isolated canvas and production user-data binding. It
does not copy bridge/OAuth or authority-integrity-key material. It does retain
the exact Application Sync registry baseline needed to remove only this run's
receipt-claimed workspace capability byte-for-byte at restore.
Launch starts the packaged app with its normal production user-data and the
isolated positional `.json` canvas, so the existing bridge/OAuth/plugin setup
is available. It reports PID/command metadata; Chromium caches and preferences
remain intentionally outside the narrow rollback scope:

```bash
node --import ./scripts/test-stubs/register.mjs \
  .test-artifacts/blackbox-run/one-card-live-acceptance.mjs launch \
  --run-id live-YYYYMMDD --execute
```

Inspect after the app reaches a terminal receipt, then quit Infinite Canvas
completely and restore. The no-secret harness owns only its new job/anchor,
fixture and pre-reserved bundle candidates. The stopped harness deliberately
does **not** rewrite `lanes.json`: only the live bridge runtime owns that
store's serialization, and Node cannot make a pathname-based conditional
rename safe against a parent-directory swap. The matching stale lane is left
for the live runtime's normal discarded/missing-bundle reconciliation. It guards
Application Sync, authority anchors, snapshot storage, and protected bridge
config/tunnel files by exact hash/metadata and refuses cleanup on drift rather
than overwriting existing user state. OAuth state is validated structurally
but allowed to persist legitimate authenticated-session changes. Append-only bridge logs and
retired-chat digests are accepted; no lane content is touched by stopped-run
cleanup, so unrelated lanes and any concurrent update survive unchanged.

```bash
node --import ./scripts/test-stubs/register.mjs \
  .test-artifacts/blackbox-run/one-card-live-acceptance.mjs inspect --run-id live-YYYYMMDD

node --import ./scripts/test-stubs/register.mjs \
  .test-artifacts/blackbox-run/one-card-live-acceptance.mjs restore \
  --run-id live-YYYYMMDD --execute
```

If a queue call itself fails after reservation and automatic scoped rollback
also fails, the run is retained with a recovery manifest instead of being
silently deleted. After quitting Infinite Canvas, use:

```bash
node --import ./scripts/test-stubs/register.mjs \
  .test-artifacts/blackbox-run/one-card-live-acceptance.mjs recover \
  --run-id live-YYYYMMDD --execute
```

Its no-ChatGPT self-test performs only read-only provenance/extraction checks;
it does not alter production user-data or bridge configuration:

```bash
node --import ./scripts/test-stubs/register.mjs \
  .test-artifacts/blackbox-run/one-card-live-acceptance.mjs self-test
```

Run its isolated proof first:

```bash
node --import ./scripts/test-stubs/register.mjs \
  .test-artifacts/blackbox-run/application-acceptance-harness.mjs self-test
```

## Isolated career-import fixture

Create a one-node canvas for testing the real Job Search career-file drop
without loading or saving the production workspace:

```bash
node --import ./scripts/test-stubs/register.mjs \
  .test-artifacts/blackbox-run/application-acceptance-harness.mjs \
  career-import-fixture
```

It writes
`.test-artifacts/blackbox-run/fixtures/career-import-d4471f24-fb63-4c24-bb04-d919f295b1c9.canvas`
with exactly the existing Job Search hub ID, its raw pre-run search settings,
and no edges, results, career fields, run/recovery data, or source-file path.
The command reads (but never copies, moves, or writes) the production canvas
and `Work Experience.md`; it refuses to overwrite an existing fixture.

After opening that fixture, the empty hub can accept a normal native-file drop.
For the document-card fixture below, prefer the visible **Import from canvas
files** control: it is keyboard-accessible, shows the current-canvas files,
and requires an explicit checkbox selection before importing. The fixture
itself holds no path back to the production workspace, so autosave has only
the fixture path as its target after it is loaded.

To test the supported in-canvas document-node ingress instead of a Finder
drag, add `--include-document`:

```bash
node --import ./scripts/test-stubs/register.mjs \
  .test-artifacts/blackbox-run/application-acceptance-harness.mjs \
  career-import-fixture --include-document
```

This creates
`.test-artifacts/blackbox-run/fixtures/career-import-d4471f24-fb63-4c24-bb04-d919f295b1c9-with-document.canvas`.
It has the same empty hub plus one production-shaped `document` node carrying
only `filename` and `filePath` for `Work Experience.md` (and `locked: true` to
make the source read-only in the fixture). On the hub, choose **Import from
canvas files**, check the displayed `Work Experience.md` entry, then choose
**Import 1 file**. This calls the same career-import ingress as a document-node
drop, including its lock, compiler-first, and Board-admission checks. Dragging
the document card onto the hub remains an optional equivalent pointer route;
it is not the sole acceptance path. This explicit variant is the only fixture
that references `Work Experience.md`; it still has no path or sidecar reference
to the production canvas, and it never copies or writes the source file.

The packaged app's current Open Canvas picker is filtered to `*.json`, though
the load IPC itself accepts this JSON-formatted `.canvas` path. If the picker
cannot select the suffix on a given macOS build, create the fixture with an
explicit picker-friendly output name instead:

```bash
node --import ./scripts/test-stubs/register.mjs \
  .test-artifacts/blackbox-run/application-acceptance-harness.mjs \
  career-import-fixture \
  --output .test-artifacts/blackbox-run/fixtures/career-import-d4471f24-fb63-4c24-bb04-d919f295b1c9.canvas.json
```

This remains the same isolated JSON content and must also be created only once.
Structural proof (no app launch, snapshot compilation, or source mutation):

```bash
node --import ./scripts/test-stubs/register.mjs \
  .test-artifacts/blackbox-run/application-acceptance-harness.mjs \
  career-import-fixture-self-test
```

For the real canvas, every state-changing command requires `--execute` and
accepts only these exact paths:

```text
/Users/jack/Desktop/Job Search/canvas.json
/Users/jack/Library/Application Support/infinite-canvas
```

For a fresh production source, import the file through the packaged app. That
is the only path that performs the current AI compile and independent audits,
then atomically publishes the current snapshot. Do **not** use the historical
`approved-snapshot.json` or `candidate-profile.json` in this directory for a
live run.

Create a baseline before every live run. Do not run Infinite Canvas elsewhere
against the same canvas while the harness is active.

```bash
node --import ./scripts/test-stubs/register.mjs \
  .test-artifacts/blackbox-run/application-acceptance-harness.mjs \
  backup --run-id acceptance-YYYYMMDD --execute
```

`publish-snapshot` is retained only for a separately archived snapshot that
already passes the current validator. It re-reads the resulting pin through
the production reader; it never compiles a profile or source file. Create the
run baseline first: publishing is refused unless that run already has its
ownership manifest, so the exact snapshot-store file and its source SHA-256
are recorded before cleanup is possible.

```bash
node --import ./scripts/test-stubs/register.mjs \
  .test-artifacts/blackbox-run/application-acceptance-harness.mjs \
  publish-snapshot --run-id acceptance-YYYYMMDD \
  --snapshot /absolute/approved-snapshot.json \
  --snapshot-id <64-lowercase-hex> --execute
```

Queue exactly one production paste/ChatGPT handoff and pin that one card. This
creates the same private `.local-ai/jobs/<uuid>` state used by **Generate** in
JobCardNode, so the renderer's application dock and ChatGPT worker/plugin path
can discover and progress it. Keep the real Infinite Canvas renderer open for
its production import/render/save lifecycle; do not use the retired filesystem
`result.json` shortcut for this acceptance run.

```bash
node --import ./scripts/test-stubs/register.mjs \
  .test-artifacts/blackbox-run/application-acceptance-harness.mjs \
  pin-and-queue --run-id acceptance-YYYYMMDD --card snowflake \
  --snapshot-id <64-lowercase-hex> --execute
```

Allowed cards are `snowflake`, `retool`, `anthropic`, and the optional
`affirm`. Process/save one to terminal receipt before queueing the next. The
command clears only the selected card's `localApplication` (which is necessary
to rotate Affirm's stale failed pointer) and sets only its snapshot/pointer.
Before it queues, the harness reserves one high-entropy UUID job folder and
the production bundle resolver's exact base, 8-hex, and 16-hex collision
candidates under `Applied Jobs/<company>/<location>/<title>`. The production
queue is injected with that UUID only through a one-shot non-IPC harness seam;
an interrupted queue can therefore be cleaned only after its manifest/input
prove that exact UUID and canvas identity.

Inspect without mutation:

```bash
node --import ./scripts/test-stubs/register.mjs \
  .test-artifacts/blackbox-run/application-acceptance-harness.mjs \
  inspect --run-id acceptance-YYYYMMDD --job-id <uuid>
```

Run this inspection after the controlled app reaches its terminal receipt and
before each cleanup. It records the receipt-declared job/bundle candidate as the
last expected test-produced state; cleanup intentionally refuses an uninspected
or concurrently altered artifact.
An output directory outside the pre-reserved candidates is rejected rather
than claimed, even when a receipt names it.

Restore only after stopping the controlled app:

```bash
node --import ./scripts/test-stubs/register.mjs \
  .test-artifacts/blackbox-run/application-acceptance-harness.mjs \
  restore --run-id acceptance-YYYYMMDD --execute
```

The default is fail-closed and restores the baseline canvas plus only paths in
that run's pre-established ownership manifest: the queued job directory, a
receipt-declared pre-reserved bundle candidate, and the published
`career-snapshot-store/career-snapshots/<id>.json`. It does not reconcile or
delete arbitrary additions elsewhere in `.local-ai` or `Applied Jobs`; an
unrelated concurrent addition survives. Before changing anything, restore
requires every owned target to match its last exact test-produced digest. A
changed file, renamed path, type change, symlink, or overlapping concurrent
edit aborts the whole cleanup before the canvas is touched.

If the run intentionally produced a new current-schema approved snapshot that
you have independently decided to retain, opt in explicitly:

```bash
node --import ./scripts/test-stubs/register.mjs \
  .test-artifacts/blackbox-run/application-acceptance-harness.mjs \
  restore --run-id acceptance-YYYYMMDD --keep-published-snapshot --execute
```

That narrowly preserves only the ownership-recorded approved snapshot; it does
not retain jobs or bundles. Without that option, cleanup removes the newly
published snapshot and empty test-created snapshot directories. Existing
baseline directories are repaired in place rather than deleted. Canvas and
owned files are verified by SHA-256, byte count, mode, and mtime; owned tree
digests, snapshot source SHA-256, snapshot-store state, and the byte-exact
Application Sync registry are also verified. A registry change is never
silently overwritten because this harness does not own it.
