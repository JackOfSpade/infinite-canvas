// ── Bug report save-to-disk pointer (Copy to Clipboard, redesigned) ────────────
//
// "Copy to clipboard" used to hand the renderer the report markdown itself,
// capped at CLIPBOARD_BUG_REPORT_MAX_CHARS so a giant canvas-scale report
// wouldn't blow up whatever consumed the paste. That capping was already a
// lossy compromise (see bugReport.js). The real fix: generate the FULL
// uncapped report (same content "Save to file" produces), write it to an
// app-managed file, and hand the clipboard a SHORT pointer at that path. An
// AI reading the pasted report can then read the file from disk in segments
// instead of receiving one giant paste that either gets silently truncated
// downstream or burns most of a context window in one message.
//
// The saved-report directory is NOT a permanent archive — it exists only to
// bridge "generated this session" to "read by whatever consumed the
// clipboard paste, during this same session". main.js clears it once at
// startup (see clearSavedBugReports below) so filing many reports across many
// app sessions can never grow it without bound, and writeSavedBugReport
// additionally prunes to SAVED_REPORT_RETENTION files as a same-session
// second guard against a single runaway session filing hundreds of reports.

import electronPkg from 'electron';
import fs from 'fs';
import path from 'path';

const { app } = electronPkg;

export const SAVED_REPORT_DIR = 'bug-reports';
export const SAVED_REPORT_RETENTION = 20;

// The delete gate for both clearSavedBugReports and the retention prune. Be
// precise about what this actually guarantees: it matches the NAME SHAPE this
// module writes, not the file's authorship — nothing here can distinguish a
// file we wrote from one that merely looks like it. A file with an unrelated
// name (notes.txt, a saved copy under any other name) is therefore safe; a
// foreign file deliberately named `bug-report-*.md` inside this app-managed
// directory is not, and will be swept like our own.
const SAVED_REPORT_FILE_RE = /^bug-report-.*\.md$/;

// `app.getPath('userData')` throws before `app.whenReady()` resolves, so this
// is computed at CALL TIME rather than cached at module load — the same
// convention electron/ipc/jobs.js (see analysisPathsForCanvas) and
// electron/ipc/skillOpportunityStore.js (see skillOpportunityHistogramFilePath)
// already use for the same reason.
export function savedBugReportDir() {
  return path.join(app.getPath('userData'), SAVED_REPORT_DIR);
}

// A report can be written moments after the app boots — the "Copy to
// clipboard" click that triggers a write and the startup clear are racing by
// design. Without this guard a slow clear (many stale files, a slow disk)
// could delete the very file a report the user just generated points at.
// clearSavedBugReports stashes its own in-flight promise here so
// writeSavedBugReport can await it — success or failure — before it ever
// creates the directory or a file inside it.
let inFlightClear = null;

// Test-only reset: without this, a clear kicked off by one test's app-start
// simulation would leak into the next test's writeSavedBugReport call and
// make it wait on a promise nothing in that test ever awaited or observed.
// Matches the `__xForTests` escape-hatch convention used elsewhere (see
// electron/ipc/applicationSync.js __resetApplicationSyncWorkspacesForTests).
export function __resetSavedBugReportClearForTests() {
  inFlightClear = null;
}

async function performClear() {
  // Resolved INSIDE the try: `savedBugReportDir()` reaches app.getPath, which
  // can throw. Outside the try that throw would REJECT this promise, breaking
  // the "every failure path resolves with { error }" contract the callers below
  // are documented to rely on.
  let dir = null;
  let removed = 0;
  try {
    dir = savedBugReportDir();
    // Create rather than merely check: a fresh userData dir (first run) has
    // no bug-reports/ subfolder yet, and that must read as "nothing to
    // remove", not an error.
    await fs.promises.mkdir(dir, { recursive: true });
    const entries = await fs.promises.readdir(dir);
    for (const name of entries) {
      if (!SAVED_REPORT_FILE_RE.test(name)) continue; // differently-named files are left alone
      try {
        await fs.promises.unlink(path.join(dir, name));
        removed++;
      } catch {
        // Best-effort per file: one locked/already-gone entry must not stop
        // the rest of the sweep from running.
      }
    }
    return { dir, removed, error: null };
  } catch (err) {
    return { dir, removed, error: err?.message || String(err) };
  }
}

// Called once, fire-and-forget, from the very top of main.js's
// app.whenReady().then() callback. MUST NEVER THROW: that callback is one
// synchronous function body, and an uncaught throw anywhere inside it aborts
// every later step, including createWindow(). Every failure path above
// resolves with `{ error }` instead of rejecting, so there is nothing here
// for a caller to accidentally let escape as a rejection either.
export async function clearSavedBugReports() {
  const promise = performClear();
  inFlightClear = promise;
  return promise;
}

function timestampSlug(date) {
  return date.toISOString().replace(/[:.]/g, '-');
}

// Two reports generated within the same millisecond (realistic if two windows
// each file one around the same moment, or a user mashes the button) would
// otherwise collide on the ISO-timestamp name. A check-then-write ("does this
// path exist? no? write it") is a TOCTOU race under real concurrency: two
// calls can both see "does not exist" before either has created its file,
// and the second write silently clobbers the first report. `flag: 'wx'`
// makes "claim this exact name" a single atomic filesystem operation — on a
// collision it rejects with EEXIST instead of overwriting, so the retry loop
// below only ever *observes* a genuine collision, never races one.
async function writeCollisionFreeReport(dir, date, content) {
  const base = `bug-report-${timestampSlug(date)}`;
  for (let suffix = 0; ; suffix++) {
    const candidate = suffix === 0 ? path.join(dir, `${base}.md`) : path.join(dir, `${base}-${suffix + 1}.md`);
    try {
      await fs.promises.writeFile(candidate, content, { encoding: 'utf8', flag: 'wx' });
      return candidate;
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err; // any other failure is real (permissions, disk full, ...) — surface it
    }
  }
}

// Best-effort: a failure here must never turn a successful write into a
// reported failure. The write already landed and its path was already
// returned to the caller; only cleanup of OLDER files is at stake.
async function pruneOldSavedReports(dir) {
  try {
    const entries = await fs.promises.readdir(dir);
    const reportFiles = entries.filter((name) => SAVED_REPORT_FILE_RE.test(name));
    if (reportFiles.length <= SAVED_REPORT_RETENTION) return;

    // Sort by mtime, not filename: the filename embeds a generation
    // timestamp, but a collision suffix (`-2`, `-3`, …) would otherwise sort
    // a same-millisecond file out of true age order.
    const stated = await Promise.all(reportFiles.map(async (name) => {
      const filePath = path.join(dir, name);
      try {
        const stat = await fs.promises.stat(filePath);
        return { filePath, mtimeMs: stat.mtimeMs };
      } catch {
        return null; // vanished between readdir and stat; nothing to prune
      }
    }));
    const alive = stated.filter(Boolean).sort((a, b) => a.mtimeMs - b.mtimeMs);
    const excess = alive.length - SAVED_REPORT_RETENTION;
    for (let i = 0; i < excess; i++) {
      await fs.promises.unlink(alive[i].filePath).catch(() => {});
    }
  } catch {
    // Listing itself failed (e.g. directory removed underneath us) — the
    // report this call exists to protect was already written successfully.
  }
}

// May throw (mkdir/write failures propagate) — the caller (bugReport.js's
// generate-bug-report-markdown handler) needs that failure to trigger its
// inline-fallback path rather than silently reporting success with nothing
// on disk.
export async function writeSavedBugReport(markdown, meta = {}) {
  void meta; // reserved for future provenance (e.g. reportWindowId); unused today
  // Never race the startup sweep — see the `inFlightClear` comment above.
  if (inFlightClear) await inFlightClear.catch(() => {});

  const dir = savedBugReportDir();
  await fs.promises.mkdir(dir, { recursive: true });
  const filePath = await writeCollisionFreeReport(dir, new Date(), markdown);

  await pruneOldSavedReports(dir);

  return {
    filePath,
    // Both, because they are different questions and the pointer answers the
    // first one: `chars` is what a reader budgeting a context window needs,
    // `bytes` is what the file actually occupies. They diverge on any
    // multi-byte content — and this app deliberately retains foreign-language
    // job listings untranslated, so that divergence is routine, not exotic.
    chars: markdown.length,
    bytes: Buffer.byteLength(markdown, 'utf8'),
    lines: markdown.length === 0 ? 0 : markdown.split('\n').length,
  };
}

// Pure — no fs, no electron — so the exact clipboard pointer text is
// trivially unit-testable without touching disk. This is deliberately the
// ONLY thing an AI reading the clipboard paste sees inline; the entire point
// of the redesign is that this stays short while the real content lives in
// the file it points at.
export function buildClipboardPointer(info = {}) {
  // The retention prune runs on every write, so a pointer cannot promise the
  // file survives the whole session — after SAVED_REPORT_RETENTION newer
  // reports it is gone. Say both triggers rather than only the app-restart one.
  const retention = SAVED_REPORT_RETENTION;
  const { filePath, chars, bytes, lines, eventLines, filterCode, generatedAt, description } = info;
  // Prefer the true character count; fall back to the byte count only for a
  // caller that never supplied one. Labelling bytes as "chars" overstated the
  // size an AI was about to read whenever the report held multi-byte text.
  const sizeChars = Number.isFinite(chars) ? chars : bytes;

  const formatCount = (value) => (Number.isFinite(value) ? value.toLocaleString('en-US') : String(value));
  const eventLineClause = eventLines === null || eventLines === undefined
    ? ''
    : ` · event log ${formatCount(eventLines)} line(s)`;
  const code = String(filterCode || '').trim() || 'FULL';

  const trimmedDescription = typeof description === 'string' ? description.trim() : '';
  const boundedDescription = trimmedDescription.length > 500
    ? `${trimmedDescription.slice(0, 500)}…`
    : trimmedDescription;
  const descriptionSection = boundedDescription
    ? `\n\n## Issue Description\n${boundedDescription}`
    : '';

  return `# Bug Report — saved to a file (not pasted inline)

Read the full report from this path:

\`${filePath}\`

- Size: ${formatCount(sizeChars)} chars · ${formatCount(lines)} lines${eventLineClause}
- Filter code: ${code}
- Generated: ${generatedAt}
- Lifetime: deleted when this app next starts, or once ${retention} newer reports are filed — read it now.

This file may be too large to read in one pass. Read it in segments (line or byte
offsets) rather than expecting its contents inline.${descriptionSection}`;
}
