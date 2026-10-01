// ── Bug report save-to-disk pointer (Copy to Clipboard, redesigned) ────────────
//
// "Copy to clipboard" used to hand the renderer the report markdown itself,
// capped at CLIPBOARD_BUG_REPORT_MAX_CHARS so a giant canvas-scale report
// wouldn't blow up whatever consumed the paste. That capping was already a
// lossy compromise (see bugReport.js). The real fix: generate the FULL
// uncapped report (same content "Save to file" produces), write it to an
// app-managed file, and hand the clipboard a file-backed pointer at that
// path. The report body stays on disk for segmented reading, while the
// intentionally user-authored issue description is included inline in full.
//
// The saved-report directory is a short-lived handoff archive. A clipboard
// pointer may be consumed after Electron restarts (for example, an assistant
// can open the app while it is investigating the path), so deleting every
// report at startup would invalidate the pointer before it can be read.
// Keep a best-effort bounded recent history instead: main.js and each write
// target reports older than SAVED_REPORT_MAX_AGE_MS and reports outside the
// SAVED_REPORT_RETENTION newest. This controls normal disk growth without
// making a restart destructive.

import electronPkg from 'electron';
import fs from 'fs';
import path from 'path';

const { app } = electronPkg;

export const SAVED_REPORT_DIR = 'bug-reports';
export const SAVED_REPORT_RETENTION = 20;
export const SAVED_REPORT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// The delete gate for the startup and write-time retention prunes. Be
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
// clipboard" click that triggers a write and the startup prune are racing by
// design. Without this guard, a concurrent prune could count files before a
// write finishes and leave retention timing nondeterministic. The startup
// prune stashes its own in-flight promise here so
// writeSavedBugReport can await it — success or failure — before it ever
// creates the directory or a file inside it.
let inFlightStartupPrune = null;

// Test-only reset: without this, a prune kicked off by one test's app-start
// simulation would leak into the next test's writeSavedBugReport call and
// make it wait on a promise nothing in that test ever awaited or observed.
// Matches the `__xForTests` escape-hatch convention used elsewhere (see
// electron/ipc/applicationSync.js __resetApplicationSyncWorkspacesForTests).
export function __resetSavedBugReportPruneForTests() {
  inFlightStartupPrune = null;
}

async function pruneSavedReports({ protectedFilePath = null } = {}) {
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
    // prune", not an error.
    await fs.promises.mkdir(dir, { recursive: true });
    const entries = await fs.promises.readdir(dir);
    const now = Date.now();
    const stated = await Promise.all(entries
      .filter((name) => SAVED_REPORT_FILE_RE.test(name))
      .map(async (name) => {
        const filePath = path.join(dir, name);
        try {
          const stat = await fs.promises.stat(filePath);
          return stat.isFile() ? { filePath, mtimeMs: stat.mtimeMs } : null;
        } catch {
          return null; // vanished or unreadable between readdir and stat
        }
      }));
    const reports = stated.filter(Boolean).sort((a, b) => a.mtimeMs - b.mtimeMs);
    const expired = reports.filter((report) => now - report.mtimeMs > SAVED_REPORT_MAX_AGE_MS);
    const fresh = reports.filter((report) => now - report.mtimeMs <= SAVED_REPORT_MAX_AGE_MS);
    // A newly written report is protected from the write-time pruning pass.
    // Filesystems can assign equal mtime values to a rapid burst of writes, so
    // sorting alone cannot prove the current pointer is the newest one.
    const removableFresh = protectedFilePath
      ? fresh.filter((report) => report.filePath !== protectedFilePath)
      : fresh;
    const overCount = removableFresh.slice(0, Math.max(0, fresh.length - SAVED_REPORT_RETENTION));
    for (const { filePath } of [...expired, ...overCount]) {
      try {
        await fs.promises.unlink(filePath);
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
export async function pruneSavedBugReports() {
  const promise = pruneSavedReports();
  inFlightStartupPrune = promise;
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

// Best-effort: a cleanup failure must never turn a successful report write
// into a reported failure. The report already landed on disk; only cleanup of
// older files is at stake.
// May throw (mkdir/write failures propagate) — the caller (bugReport.js's
// generate-bug-report-markdown handler) needs that failure to trigger its
// inline-fallback path rather than silently reporting success with nothing
// on disk.
export async function writeSavedBugReport(markdown, meta = {}) {
  void meta; // reserved for future provenance (e.g. reportWindowId); unused today
  // Never race the startup prune — see the `inFlightStartupPrune` comment above.
  if (inFlightStartupPrune) await inFlightStartupPrune.catch(() => {});

  const dir = savedBugReportDir();
  await fs.promises.mkdir(dir, { recursive: true });
  const filePath = await writeCollisionFreeReport(dir, new Date(), markdown);

  // The report just landed successfully. Retention cleanup is best-effort, so
  // a transient directory/listing failure cannot turn that success into a
  // failed clipboard pointer.
  await pruneSavedReports({ protectedFilePath: filePath });

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
// report metadata plus any intentionally user-authored issue description an
// AI reading the clipboard paste sees inline; generated diagnostic content
// remains in the file it points at.
export function buildClipboardPointer(info = {}) {
  // Retention cleanup is triggered at startup and on every write. It is
  // best-effort, so a pointer is durable across restarts but cannot promise
  // permanent storage or an exact deletion time.
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

  // The description is intentional user-authored handoff context, not a
  // diagnostic sample. The saved report and its clipboard pointer must agree
  // on it exactly; a preview cap here made an AI act on an incomplete issue
  // even though the file retained the rest.
  const fullDescription = typeof description === 'string' ? description : '';
  const descriptionSection = fullDescription
    ? `\n\n## Issue Description\n${fullDescription}`
    : '';

  return `# Bug Report — saved to a file (not pasted inline)

Read the full report from this path:

\`${filePath}\`

- Size: ${formatCount(sizeChars)} chars · ${formatCount(lines)} lines${eventLineClause}
- Filter code: ${code}
- Generated: ${generatedAt}
- Lifetime: retained across app restarts; on app start or a later report write, best-effort cleanup normally prunes reports older than 7 days or outside the ${retention} newest — read it soon.

This file may be too large to read in one pass. Read it in segments (line or byte
offsets) rather than expecting its contents inline.${descriptionSection}`;
}
