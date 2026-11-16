# Interview Helper app

Interview Helper is its own desktop app, built from this repository alongside
Infinite Canvas. The two share code but nothing at build or run time, so either
can be rebuilt and relaunched while the other stays open.

| | Infinite Canvas | Interview Helper |
| --- | --- | --- |
| Build | `npm run build` | `npm run build:interview` |
| Compile only | `npm run build:compile` | `npm run build:interview:compile` |
| Compiled output | `dist/`, `dist-electron/` | `dist-interview/`, `dist-electron-interview/` |
| Packaged app | `release/mac-arm64/infinite-canvas.app` | `release-interview/mac-arm64/Interview Helper.app` |
| Bundle id | `com.antigravity.infinitecanvas` | `com.antigravity.interviewhelper` |
| Packaging config | `package.json` → `build` | `electron-builder.interview.json` |
| Bundler config | `vite.config.js` | `vite.interview.config.js` |
| Launcher | `scripts/launch-app.command` | `scripts/launch-interview-helper.command` |
| Main process | `electron/main.js` | `electron/interviewApp/main.js` |
| Renderer entry | `index.html` → `src/main.jsx` | `interview.html` → `src/interview-app/main.jsx` |

Both are signed with the same identity (`build.mac.identity`). Each bundle id
has its own macOS permission grants.

## Shared code

Feature code is imported, never copied: `electron/ipc/interview*.js`,
`electron/interviewWindow.js`, `electron/practiceCall/`, the career compile
handlers in `electron/ipc/jobs.js` (`registerCareerDataHandlers`), the Claude
worker, and the `src/components/Interview*` / `src/interview-window/` /
`src/practice-call/` views. A fix there reaches each app on its next build.

The Interview Helper launcher rebuilds only when a file its build read has
changed (`dist-electron-interview/build-inputs.json`), so a Job Search-only
edit does not rebuild it. The Infinite Canvas launcher does the same with
`dist-electron/build-inputs.json`, so an edit to a file only Interview Helper
is built from does not rebuild Infinite Canvas. A file both apps bundle
rebuilds both. Each launcher falls back to hashing the whole repo until its
first build has written that list.

## Data

- **Profile** (`~/Library/Application Support/Interview Helper`): Electron's own
  files, plus the Claude worker's bookkeeping that only one process may rewrite
  (`non-api-ai-handoffs.json`, `claude-accounts/`, usage and replay logs).
- **Interview data** stays in `~/Library/Application Support/infinite-canvas`:
  `interview-helper-*`, `practice-calls`, `practice-models`,
  `practice-voice-pool.json`, `career-snapshot-store` and the list of interviews
  in `interview-helper-sessions.json`. Interview Helper is the only writer of
  the interview stores; career snapshots are content-addressed, so both apps
  can add to them and each reuses what the other compiled.

`INTERVIEW_HELPER_PROFILE_DIR` and `INTERVIEW_HELPER_DATA_DIR` (absolute paths)
point a trial run at other folders.

## What replaced the canvas

- One interview is what one Interview Helper node was, under the same id (Q&A
  and practice history are stored per id). "Import from canvas file" reads a
  canvas without writing it.
- Career files are dropped on the window or picked with "Choose files".
- Applications come from an `Applied Jobs` folder chosen once in the app.
- Changes save immediately; there is no undo.
- Infinite Canvas drops `interviewhelper` nodes on load (schema version 12).
