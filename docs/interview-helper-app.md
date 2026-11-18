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

## The cue card

The live window is a display only. The page reaches the controller
(`electron/interviewWindow.js`) through five bridge calls: `getBrief`,
`startListening`, `stopListening`, `onListeningUpdated` and `onBriefUpdated`.
The controller exports `launch`, `getBrief`, `startListening`, `stopListening`
and session helpers, nothing else. A question reaches it from the listening
path (`onQuestion`) or from a plan the canvas supplies at launch; there is no
typed question, follow-up, prepared-card choice, Next, layout or pin control.
The window opens pinned and stays pinned. The snapshot and sealed answer bank
are verified once at launch. Details: `docs/interview-live-ai-matching.md`.

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

## Typed job (built 2026-11-18)

The Application section has, under the application dropdown, a text box: "Or type a job link, or a company and role". AI reads what was typed (`electron/ipc/interviewTypedJob.js`, handler `resolve-interview-typed-job`), and the result is stored as an application artifact of the usual shape, so Prepare, the questions and the practice call run unchanged.

- **A link** is taken as a job posting link. The page is read (plain fetch, then a rendered page, then the Parallel reader) and the AI gets the unprocessed full text. A page that is not one open posting is refused with a message.
- **A company and a role** is the target. One Parallel research call identifies the organisation, its background and careers page, looks for an open posting for that role, and notes how the company writes its postings. A found posting is read and used only if it is open, from the same organisation, and one a person seeking that role would apply through (a general posting the company really uses counts).
- **No posting found:** a stand-in listing is generated from the company, role, optional location and the research only. Career data never reaches this module. The job's name ends "(generated listing)", the artifact's status is `typed-generated`, and the Prepare prompts and the brief's first warning say it is not the employer's text. Owner's request, 2026-11-18; it is the one place the app writes a listing itself.
- **Stops instead of guessing:** unclear text returns the AI's short question; an uncertain company identity (same-name companies) or failed web search stops with a message and nothing is generated.
- **No application documents.** A typed job has no résumé or cover letter (`applicationPositioning` is empty), so answer cards read "not verified against résumé" and practice interviewers probe from the questions alone.
- **Known limits.** The stored job link drops its query string like every job link here, so two postings told apart only by a query (`?gh_jid=`) share one link; the page itself is read with the query. With no location typed, the posting found may be in another region (live: a Singapore posting for "Shopify senior backend developer"); the box shows which posting was used.
- **Live checks from source, 2026-11-18:** pasted posting link used (11 s); company and role with a posting found (66 s); with none found, generated (87 s to 112 s); careers home page refused as not a posting; "backend role" answered with "Which company is this backend role at?". Not yet driven through the window itself, and the rendered-page reader has not run inside the Interview Helper process.
- **Models:** four `typed-job-*` stages, all "Needs test" in ai-model-selection.md.

## Career files of any type (built 2026-11-18)

The Interview Helper's career drop and file chooser accept any file type (owner, 2026-11-18: "convert all file types dropped to text form and use that"). The canvas app's Job Search stays `.txt`/`.md` only.

- **Conversion comes first.** `electron/ipc/careerFileToText.js` turns each file into a plain `.txt` in the private folder `interview-helper-career-conversions` (named after the original, `resume.pdf.txt`, cached by content hash), and the unchanged text-only import then compiles those files. `.txt` and `.md` pass through untouched, so existing snapshots keep their fingerprints.
- **By kind, decided by the file's signature:** RTF, HTML, CSV, JSON and other text are decoded on the machine; `.docx` and `.odt` are read on the machine; images (png, jpg, webp, gif) are read by Claude (stage `career-file-to-text`, "Needs test"), which copies the text out and marks what it cannot read `[unreadable]`.
- **PDFs use the on-machine text layer, with a visible "machine-extracted, check the converted text" note.** No safe way was found to hand a PDF to a Claude call in this app, so a scanned PDF with no text layer is refused with a reason (save its pages as images). The September concern about confidently wrong layouts is why the note and the "Open text" link exist.
- **One bad file does not stop the rest.** The panel lists each file as converted (and how) or refused with a plain reason, and imports the good ones.
- **Practice calls.** When a job has no application documents (a typed job), the planner and interviewers get the career documents' text from the snapshot in the application slot, described as documents the candidate provided and not a résumé tailored to the job.
- **Checked from source, 2026-11-18:** a Word file, RTF, HTML, a text PDF and a PNG of a résumé page all converted to the same text as the original (3.7 s for the set). Not yet driven through the window, and the converted-folder allowance in `parse-career-data` has only run in tests.
