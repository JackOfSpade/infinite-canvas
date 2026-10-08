# Isolated career-fixture launcher

> Superseded for ordinary acceptance launches by the app's normal command-line
> canvas-file handling. Retained only as an isolated-profile diagnostic helper.

`launch-career-fixture.mjs` opens the packaged Infinite Canvas application on
the small one-node career fixture without reading or writing the production
Chromium profile. It does not use the production window's accessibility tree.

Do not edit Chromium Local Storage LevelDB directly. The `file://` origin's
`infiniteCanvas.settings` record is stored across LevelDB tables and a WAL;
those files are checksum-, manifest-, lock-, and compaction-managed. A byte
replacement is not a safe one-setting update, and an ordinary LevelDB write
would change more than the intended record.

Instead, this helper requires every packaged Infinite Canvas process to be
stopped, creates a fresh temporary `--user-data-dir`, starts the repository's
packaged executable in the normal background-E2E safety mode, sets only
`lastOpenedWorkspace` through the renderer's ordinary `localStorage` API,
reloads, and verifies the fixture's sole node. The entire temporary profile is
removed afterward. Production user data, including its Local Storage files,
never needs a backup because it is never touched.

Run the non-launching proof:

```bash
node .test-artifacts/blackbox-run/launch-career-fixture.mjs self-test
```

When the real application is fully quit, run the isolated acceptance launch:

```bash
node .test-artifacts/blackbox-run/launch-career-fixture.mjs launch --execute
```

`--keep-profile` retains the disposable profile only for diagnosis. It is still
created in the system temporary directory, never under production user data.
