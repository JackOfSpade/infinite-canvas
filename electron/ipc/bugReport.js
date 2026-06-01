import electronPkg from 'electron';
const { dialog, app } = electronPkg;
import fs from 'fs';
import path from 'path';
import os from 'os';

import { handleSafe, snapshotActiveNodeTasks } from './ipcUtils.js';
import { getAISettings, resolveServiceAccountPath } from './settings.js';
import { getSellMonitorPlatforms, getJobLoginPlatforms, getStealthBrowserInfo } from './stealthBrowser.js';
import { getStatusCacheSync, getVerifyTimingSummary } from './accounts.js';
import { getRecentLogs } from '../logger.js';
import { getGeminiTelemetry } from './gemini.js';
import { getJobsTelemetry } from './jobs.js';
import { getMarketplaceTelemetry } from './marketplace.js';
import { getBudgetSnapshot } from './scrapeBudget.js';
import { getRateLimiterSnapshot } from './rateLimiter.js';
import { getTokenBudgetSnapshot, TOKEN_HARD_CAP } from './tokenBudget.js';
import { getKnownTaskIds } from './llm.js';
import { shortId, renderSessionRows, renderSessionTraceBlocks } from './bugReport/helpers.js';
import { buildJobsConfigSnapshot, buildJobsPipelineSnapshot } from './bugReport/jobsSnapshot.js';
import { buildMarketplacePipelineSnapshot } from './bugReport/marketplaceSnapshot.js';
import { getAuthWindowDiagnostics } from './browser/authWindows.js';
import {
  getJobHubTransientKeysForSave,
  TRANSIENT_PROCESSING_HUB_STATES,
} from '../../src/utils/persistenceTransientState.js';

// Captured at module load: the moment this code first ran in the main process.
// Used to detect when a user edits a source file but forgets to restart
// Electron — the renderer hot-reloads via Vite but the main-process modules
// keep running the old code, producing the maddening "I changed it, why isn't
// it doing the new thing?" failure mode.
const PROCESS_START_MS = Date.now();


/**
 * Returns the mtime (ms) of the newest main-process code file the running build
 * depends on, or null if nothing could be scanned. Comparing it to
 * PROCESS_START_MS tells us whether any code changed since the process booted —
 * the stale-build signal we want.
 *
 * It scans BOTH the source tree (`electron/`) and the bundle (`dist-electron/`),
 * under whichever of app.getAppPath()/process.cwd() they live:
 *   • `electron/` source catches "edited a file but didn't rebuild" (dev).
 *   • `dist-electron/` bundle is the artifact actually running — and in a
 *     PACKAGED app the `electron/` source isn't shipped at all (only the bundle
 *     is inside app.asar), so source-only scanning returned null → the false
 *     "(unknown)" the report kept showing. The bundle is .cjs/.mjs, not .js, so
 *     the old `.js`-only filter missed it even when the dir was present.
 */
function getNewestMainProcessSourceMtime() {
  const CODE_EXT = /\.(c|m)?js$/; // .js, .cjs, .mjs
  const roots = [];
  try { if (app?.getAppPath) roots.push(app.getAppPath()); } catch { /* ignore */ }
  try { roots.push(process.cwd()); } catch { /* ignore */ }

  const candidates = [];
  for (const root of roots) {
    if (!root) continue;
    candidates.push(path.join(root, 'electron'), path.join(root, 'dist-electron'));
  }

  let newest = 0;
  const seen = new Set();
  const walk = (dir) => {
    const resolved = path.resolve(dir);
    if (seen.has(resolved)) return;
    seen.add(resolved);

    let entries = [];
    try { entries = fs.readdirSync(resolved, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      // Defensive: these dirs shouldn't contain node_modules, but never recurse
      // into it (or dotfiles) if a candidate root ever broadens.
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const fullPath = path.join(resolved, entry.name);
      if (entry.isDirectory()) { walk(fullPath); continue; }
      if (!entry.isFile() || !CODE_EXT.test(entry.name)) continue;
      try {
        const stat = fs.statSync(fullPath);
        if (stat.mtimeMs > newest) newest = stat.mtimeMs;
      } catch { /* skip */ }
    }
  };

  for (const dir of candidates) walk(dir);
  return newest || null;
}

/**
 * Renderer (React/Vite) freshness. getNewestMainProcessSourceMtime above scans
 * only electron/ + dist-electron/ — but the renderer (`src/`) is where the
 * JobHub pipeline, the AI-scoring/test-mode gate, and most UI logic live. When
 * the app loads the BUILT bundle (main.js does loadFile('../dist/index.html')
 * whenever there's no Vite dev server), an edit to `src/` that was never
 * re-bundled means the running UI is STALE even though the main process is
 * current — the "fixed the code but it still does the old thing" trap that the
 * main-process-only check silently passed (reporting "✅ up to date").
 *
 * Returns the newest mtime under `src/` (source) and under `dist/` (the built
 * renderer bundle the app actually loads), or null for whichever can't be read.
 */
function getNewestRendererMtimes() {
  const roots = [];
  try { if (app?.getAppPath) roots.push(app.getAppPath()); } catch { /* ignore */ }
  try { roots.push(process.cwd()); } catch { /* ignore */ }

  const newestUnder = (subdir, extTest) => {
    let newest = 0;
    const seen = new Set();
    const walk = (dir) => {
      const resolved = path.resolve(dir);
      if (seen.has(resolved)) return;
      seen.add(resolved);
      let entries = [];
      try { entries = fs.readdirSync(resolved, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const fullPath = path.join(resolved, entry.name);
        if (entry.isDirectory()) { walk(fullPath); continue; }
        if (!entry.isFile() || !extTest.test(entry.name)) continue;
        try { const stat = fs.statSync(fullPath); if (stat.mtimeMs > newest) newest = stat.mtimeMs; }
        catch { /* skip */ }
      }
    };
    for (const root of roots) if (root) walk(path.join(root, subdir));
    return newest || null;
  };

  return {
    src: newestUnder('src', /\.(jsx?|tsx?|css|html)$/),  // renderer sources
    bundle: newestUnder('dist', /./),                    // any file — a rebuild touches them all
  };
}

/**
 * Captures the AI configuration relevant to "why did nothing happen when I
 * clicked X" reports. NEVER includes the raw key strings — only whether they
 * are present and (for the active key) a short prefix for sanity-checking
 * that the user pasted the right format.
 */
function buildAIConfigSnapshot() {
  let ai = {};
  try { ai = getAISettings() || {}; } catch { /* settings store may not be ready */ }

  const geminiKey = ai.geminiApiKey;
  const claudeKey = ai.anthropicApiKey;
  const provider = ai.provider || 'gemini';
  const activeKey = provider === 'claude' ? claudeKey : geminiKey;
  const keyPrefix = activeKey ? `${String(activeKey).slice(0, 7)}…` : '(none)';

  // resolveServiceAccountPath checks the user-configured path first, then
  // falls back to process.cwd()/service-account.json. Returns null if neither
  // is readable — which is the exact "I added a path but nothing happened"
  // failure mode that needs to be visible in the report.
  let resolvedSAPath = null;
  try { resolvedSAPath = resolveServiceAccountPath(); } catch { /* ignore */ }

  // Gemini works with either a UI key OR a resolvable service-account.json;
  // Claude needs the UI key.
  const effectivelyConfigured = provider === 'claude'
    ? !!claudeKey
    : (!!geminiKey || !!resolvedSAPath);

  // For Gemini, the runtime picks AI Studio when a key is set, Vertex when
  // a service-account is resolvable, and has no usable credential otherwise. Surfacing the
  // effective endpoint (not just "which keys are set") means a future
  // "billing depleted on Vertex" vs "rate-limited on AI Studio" report is
  // immediately disambiguated.
  let activeEndpoint;
  if (provider === 'claude') {
    activeEndpoint = claudeKey ? 'Anthropic API' : '(no key)';
  } else if (geminiKey) {
    activeEndpoint = 'Gemini API (AI Studio — generativelanguage.googleapis.com)';
  } else if (resolvedSAPath) {
    activeEndpoint = 'Vertex AI (aiplatform.googleapis.com via service-account)';
  } else {
    activeEndpoint = '(no credential — AI calls fail until a key is added in Settings)';
  }

  const telemetry = getGeminiTelemetry();

  return {
    provider,
    modelSelection: provider === 'gemini' ? 'dynamic fallback (best to worst across all Gemini models)' : 'auto (per-task; see llm.js TASK_MODELS)',
    hasGeminiKey: !!geminiKey,
    hasAnthropicKey: !!claudeKey,
    activeKeyPrefix: keyPrefix,
    configuredSAPath: ai.serviceAccountPath || '(unset)',
    resolvedSAPath: resolvedSAPath || '(none)',
    serviceAccountUsable: !!resolvedSAPath,
    activeEndpoint,
    effectivelyConfigured,
    geminiLastAttemptedModel: telemetry.lastAttemptedModel,
    geminiLastSuccessfulModel: telemetry.lastSuccessfulModel,
    geminiLastAttemptedError: telemetry.lastAttemptedError,
  };
}


/**
 * Renders the live tuning state of the scrape pipeline — the answer to "why did
 * this source time out / get blocked / run so slowly?" reports.
 *
 * Two halves with different lifetimes:
 *   - Rate limiter (rateLimiter.js): IN-MEMORY, resets each run. A domain's
 *     `tighten` (≥1) multiplies its seed cooldown after throttle/block signals
 *     and decays on success; global pressure shrinks pool concurrency. We list
 *     only domains that actually hit a throttle/block/error this session.
 *   - Learned budgets (scrapeBudget.js): PERSISTED across runs. Per-source EMA
 *     of time-to-ready, used to size each source's working timeout (never above
 *     its seed). Present even with no scraping this session.
 *
 * Returns '' when there's nothing to show, so the section self-omits.
 */
function buildScraperAdaptationSnapshot() {
  let rl = null, budgets = null;
  try { rl = getRateLimiterSnapshot(); } catch { /* non-fatal */ }
  try { budgets = getBudgetSnapshot(); } catch { /* non-fatal */ }

  const rlLines = [];
  if (rl && rl.domains && Object.keys(rl.domains).length > 0) {
    // Only domains that meaningfully tightened or saw a non-ok outcome — an
    // all-clean domain at tighten=1 is just noise here.
    const hot = Object.entries(rl.domains)
      .filter(([, d]) => d.tighten > 1.05 || (Array.isArray(d.recent) && d.recent.some(o => o !== 'ok')))
      .sort((a, b) => b[1].tighten - a[1].tighten);
    rlLines.push(`- Effective concurrency: ${rl.effectiveConcurrency} · global pressure: ${rl.pressure}`);
    if (hot.length === 0) {
      rlLines.push('- (no domain hit a throttle/block/error this session)');
    } else {
      for (const [domain, d] of hot) {
        const recent = Array.isArray(d.recent) && d.recent.length ? ` (recent: ${d.recent.join(', ')})` : '';
        rlLines.push(`- \`${domain}\`: tighten ${d.tighten}×${recent}`);
      }
    }
  }

  const budgetLines = [];
  if (budgets && Object.keys(budgets).length > 0) {
    for (const [key, s] of Object.entries(budgets).sort((a, b) => a[0].localeCompare(b[0]))) {
      if (!s || (!(s.samples > 0) && !(s.bodySamples > 0))) continue;
      const parts = [];
      if (s.samples > 0) {
        const note = s.samples >= 5 ? '' : ' (seed)';
        parts.push(`ema ${s.ema}ms /${s.samples}${note}`);
      }
      // Learned body-size baseline — the suspicious-empty soft-block threshold
      // is judged against this instead of a flat byte count.
      if (s.bodySamples > 0) {
        parts.push(`body ~${Math.round(s.bodyEma / 1000)}KB /${s.bodySamples}`);
      }
      budgetLines.push(`- \`${key}\`: ${parts.join(', ')}`);
    }
  }

  if (rlLines.length === 0 && budgetLines.length === 0) return '';

  return `
## Scraper Adaptation
> Live tuning for the scrape pipeline. **Rate limiter** state is in-memory
> (resets each run); **learned budgets** persist across runs. Together they
> answer "why was this source slow / blocked / timed out?" — a high \`tighten\`
> or shrunken concurrency means anti-bot signals were observed; a learned
> budget far below a source's seed means it normally settles fast. The body
> baseline is the source's typical good-response size — soft blocks are flagged
> when a response is anomalously small relative to it.

### Rate limiter (this session)
${rlLines.length ? rlLines.join('\n') : '- (rate limiter idle this session)'}

### Learned scrape budgets (persisted)
${budgetLines.length ? budgetLines.join('\n') : '- (no source has a recorded sample yet — all using seed timeouts)'}
`;
}

/**
 * Reads the auto-loaded workspace file from disk and reports whether any hub
 * node carries transient state that should have been stripped before save.
 *
 * This is the load-bearing fact for "stale banner survives restart" reports:
 * the rest of the report shows the *in-memory* node data, which legitimately
 * holds the error during a live session — that is NOT the bug. Only a transient
 * field baked into the on-disk file proves a true persistence bug (vs. volatile
 * state that the next save will clean). Without this section the two are
 * indistinguishable without manually opening the JSON file.
 */
function buildPersistedWorkspaceSnapshot(frontEndState) {
  const filePath = frontEndState?.currentFile || frontEndState?.settings?.lastOpenedWorkspace || null;
  if (!filePath) {
    return `
## Persisted Workspace Snapshot
- No auto-loaded workspace (currentFile / lastOpenedWorkspace unset) — nothing persists across restart.
`;
  }

  let raw, mtime;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
    mtime = fs.statSync(filePath).mtime.toISOString();
  } catch (err) {
    return `
## Persisted Workspace Snapshot
- File: \`${filePath}\`
- ⚠️ Could not read file on disk: ${err?.message || String(err)}
`;
  }

  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (err) {
    return `
## Persisted Workspace Snapshot
- File: \`${filePath}\` (mtime ${mtime})
- ⚠️ File is not valid JSON: ${err?.message || String(err)}
`;
  }

  // Check if sidecar exists
  const sidecarPath = filePath.endsWith('.json') ? filePath.slice(0, -5) + '.progress.json' : filePath + '.progress.json';
  let sidecarExists = false;
  try {
    sidecarExists = fs.existsSync(sidecarPath);
  } catch { /* ignore */ }

  // Walk all nodes (recursing into group sub-canvases) looking for hubs that
  // carry transient fields. Each offender is a node whose stale state will be
  // replayed on the next auto-load.
  const offenders = [];
  if (parsed?.transientProgress) {
    offenders.push('  - `canvas`: Contains embedded `transientProgress` state on disk (should have been stripped/deleted immediately on load)');
  }
  let hubCount = 0;
  const walk = (nodes) => {
    if (!Array.isArray(nodes)) return;
    for (const n of nodes) {
      if (n?.type === 'jobhub' || n?.type === 'sellhub') {
        hubCount++;
        const d = n.data || {};
        const hits = [];
        if (TRANSIENT_PROCESSING_HUB_STATES.includes(d.hubState)) hits.push(`hubState=${d.hubState}`);
        if (n.type === 'jobhub') {
          // Data-driven over the authoritative key list: a future transient key
          // added to JOBHUB_TRANSIENT_KEYS is flagged automatically. (A previous
          // hardcoded if-chain would silently skip any unrecognized key, defeating
          // this section's purpose — it would falsely read "✅ Clean".)
          for (const key of getJobHubTransientKeysForSave(d.hubState)) {
            const v = d[key];
            if (Array.isArray(v)) { if (v.length) hits.push(`${key}=${v.length}`); }
            else if (v) hits.push(v === true ? `${key}=true` : typeof v === 'string' ? `${key}="${v.slice(0, 60)}"` : `${key}=set`);
          }
        }
        if (n.type === 'sellhub' && d.platformFitPending) hits.push('platformFitPending=true');
        if (hits.length) offenders.push(`  - \`${shortId(n.id)}\` (${n.type}): ${hits.join(', ')}`);
      }
      if (n?.type === 'group' && n.data?.canvasData?.nodes) walk(n.data.canvasData.nodes);
    }
  };
  walk(parsed?.nodes);

  const verdict = offenders.length
    ? `⚠️ **${offenders.length} item(s) carry transient state on disk** — these replay on every auto-load (true persistence bug):\n${offenders.join('\n')}`
    : '✅ Clean — no transient hub state (errorMessage / isRateLimit / scrapeWarnings / pendingJobs / mid-run hubState) or embedded progress is persisted.';

  return `
## Persisted Workspace Snapshot
> What is ACTUALLY on disk in the auto-loaded workspace, vs. the in-memory
> node data shown elsewhere. The in-memory copy legitimately holds error/
> pending state during a live session; only a field found HERE proves a
> bug where stale state survives a restart.

- File: \`${filePath}\` (mtime ${mtime})
- Embedded progress state on disk: \`${parsed?.transientProgress ? 'Yes' : 'No'}\`
- Legacy progress sidecar: \`${sidecarExists ? 'Present (will restore on load)' : 'None'}\`
- Persisted hub nodes scanned: ${hubCount}
- ${verdict}
`;
}

// ── Shared markdown generation ────────────────────────────────────────────────
// Used by both the "save to file" and "copy to clipboard" handlers so the
// report content is identical regardless of how the user chooses to export it.
const CLIPBOARD_BUG_REPORT_MAX_CHARS = 50_000;

function buildFencedTextBlock(lines, emptyFallback) {
  if (!Array.isArray(lines) || lines.length === 0) return `${emptyFallback}\n`;
  return `\`\`\`text\n${lines.join('\n')}\n\`\`\`\n`;
}

function buildMainProcessLogsMarkdown(lines) {
  if (!Array.isArray(lines) || lines.length === 0) return '';
  return `
## Recent Main-Process Logs
> Last ~60 lines from the main process's logger (ring buffer). Use this to
> see what \`[Accounts]\` / \`[StealthBrowser]\` / \`[Marketplace]\` actually
> did and any errors that were swallowed by an IPC handler before the
> renderer got a useful response.

\`\`\`
${lines.join('\n')}
\`\`\`
`;
}

function enforceClipboardMarkdownCap(baseMarkdown, eventLines, mainProcessLogLines, maxChars) {
  let eventWorking = Array.isArray(eventLines) ? [...eventLines] : [];
  let logWorking = Array.isArray(mainProcessLogLines) ? [...mainProcessLogLines] : [];
  let trimmedEventCount = 0;
  let trimmedLogCount = 0;

  const compose = (notice = '') => (
    `${notice}${baseMarkdown}${buildMainProcessLogsMarkdown(logWorking)}## Event History\n${buildFencedTextBlock(eventWorking, '*(No events recorded)*')}`
  );

  let markdown = compose();
  while (markdown.length > maxChars && eventWorking.length > 0) {
    eventWorking.shift();
    trimmedEventCount++;
    markdown = compose();
  }
  while (markdown.length > maxChars && logWorking.length > 0) {
    logWorking.shift();
    trimmedLogCount++;
    markdown = compose();
  }

  let hardTruncated = false;
  let notice = '';
  if (trimmedEventCount > 0 || trimmedLogCount > 0) {
    const parts = [];
    if (trimmedEventCount > 0) parts.push(`${trimmedEventCount} oldest event history line(s)`);
    if (trimmedLogCount > 0) parts.push(`${trimmedLogCount} oldest main-process log line(s)`);
    notice = `> Clipboard export truncated to ${maxChars} chars by dropping ${parts.join(' and ')} first.\n\n`;
  }

  markdown = compose(notice);
  if (markdown.length > maxChars) {
    hardTruncated = true;
    const suffix = `\n\n> Clipboard export hit the hard ${maxChars}-character limit; remaining tail content was truncated.\n`;
    markdown = markdown.slice(0, Math.max(0, maxChars - suffix.length)) + suffix;
  }

  return {
    markdown,
    truncated: trimmedEventCount > 0 || trimmedLogCount > 0 || hardTruncated,
    trimmedEventCount,
    trimmedLogCount,
    hardTruncated,
  };
}

export function generateMarkdown(payload, reportWindowId = null, options = {}) {
  const { description, nodes, edges, drawings, frontEndState, nodeInternals, nodeComponentStates, mediaState, imageState, lastSaveError, activeEditableText } = payload;

  // A filter code (e.g. LEAN) may have dropped whole sections before the payload
  // reached us. Track that so the summary can say "omitted by filter" rather than
  // mislabel an omitted section as empty ("Nodes: 0").
  const sectionOmitted = (name) =>
    Array.isArray(payload.filterStats?.omittedSections) &&
    payload.filterStats.omittedSections.includes(name);

  // Canvas-content guards — gate module-specific sections on whether this canvas
  // actually has nodes of that type, so sell-side sections don't bleed into a
  // job-only canvas and vice versa.
  const hasJobNodes = (nodes || []).some(n => n?.type?.toLowerCase().startsWith('job'));
  const hasSellNodes = (nodes || []).some(n => {
    const t = n?.type?.toLowerCase();
    return t === 'sellhub' || t === 'marketplacecard' || t === 'listing' || t === 'compsourcecard';
  });
  const wantsAuthDiagnostics = /login|log in|logged|sign.?in|auth|account|indeed|glassdoor|ziprecruiter/i.test(description || '');
  // FULL (or no code) must mean EVERYTHING — otherwise description-keyword-gated
  // sections silently vanish on a FULL report. "window not opening" (a captcha/
  // login window) doesn't match the auth keywords above, so without this the
  // Auth Window Diagnostics section was dropped even under FULL.
  const reportCode = String(payload.filterCode || '').trim().toUpperCase();
  const isFullReport = !reportCode || reportCode.includes('FULL');

  const systemInfo = {
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    appVersion: app.getVersion(),
    nodeVersion: process.versions.node,
    electronVersion: process.versions.electron,
    totalMemMB: Math.round(os.totalmem() / 1024 / 1024),
    freeMemMB: Math.round(os.freemem() / 1024 / 1024),
  };


  // ── Diagnostic section: group node size fields ─────────────────────────────
  // Shows style.width / measured.width / width prop separately.
  // A mismatch here (e.g. measured growing while style stays constant) is
  // the signature of the ReactFlow ResizeObserver race condition.
  const compStateById = {};
  (nodeComponentStates || []).forEach(s => { compStateById[s.id] = s; });

  // Index full nodes by id so we can pull `data` for the preview column —
  // nodeInternals is intentionally stripped of `data` to keep its shape small.
  const nodeDataById = {};
  (nodes || []).forEach(n => { nodeDataById[n.id] = n.data || {}; });
  const sourceCardsByHub = {};
  (nodes || []).forEach(n => {
    if (n?.type !== 'jobsourcecard') return;
    const hubId = n?.data?.hubId;
    if (!hubId) return;
    (sourceCardsByHub[hubId] ||= []).push(n);
  });

  let nodeDiagMarkdown = '';
  if (nodeInternals && nodeInternals.length > 0) {
    // Cap routine result cards (plain jobcards with no anomalies) so a large
    // results canvas doesn't blow the clipboard char budget — at ~150 chars/row,
    // 130+ jobcards alone exceed 18KB and force the (far more valuable) main-process
    // logs + event history to be dropped entirely. A routine jobcard's data
    // (score, source, url) is already summarized in the Taxonomy section above, so
    // omitting the tail beyond a sample loses no diagnostic signal. Any jobcard
    // with an anomaly (selected/hidden/editing/resizing/error) is ALWAYS kept.
    const ROUTINE_JOBCARD_CAP = 15;
    const isRoutineJobcard = (n) => {
      if (n.type !== 'jobcard' || n.selected || n.hidden) return false;
      const cs = compStateById[n.id] || {};
      if (cs.isEditing || cs.isResizing || cs.hasEdgeCursor) return false;
      if (nodeDataById[n.id]?.errorMessage) return false;
      return true;
    };
    let routineShown = 0;
    let routineOmitted = 0;
    const nodesToRender = [];
    for (const n of nodeInternals) {
      if (isRoutineJobcard(n)) {
        if (routineShown >= ROUTINE_JOBCARD_CAP) { routineOmitted++; continue; }
        routineShown++;
      }
      nodesToRender.push(n);
    }
    const rows = nodesToRender.map(n => {
      const cs = compStateById[n.id] || {};
      const flags = [
        n.hidden ? 'hidden' : null,
        cs.isEditing ? 'editing' : null,
        cs.isResizing ? 'resizing' : null,
        cs.hasEdgeCursor ? 'edgeCursor' : null,
        n.selected ? 'selected' : null,
      ].filter(Boolean).join(', ') || '—';
      // Hub-aware preview: include hubState plus whichever payload keys this
      // node carries. `nodeInternals` is intentionally stripped of `data`, so
      // pull from `nodeDataById` (built above from the full `nodes` array).
      const d = nodeDataById[n.id] || {};
      const previewParts = [];
      if (d.hubState) previewParts.push(`hubState: ${d.hubState}`);
      if (typeof d.scrapedCount === 'number') previewParts.push(`scraped: ${d.scrapedCount}`);
      if (typeof d.resultCount === 'number' && d.hubState === 'done') previewParts.push(`results: ${d.resultCount}`);
      if (d.errorMessage) previewParts.push(`err: ${String(d.errorMessage).slice(0, 60)}`);
      if (d.isRateLimit) previewParts.push(`rateLimit: true`);
      // Warnings: show total + block-severity + DISTINCT source breakdown. The
      // hub renders one card per source but stores one warning per blocked
      // query, so the raw warning count can exceed the number of visible cards
      // (e.g. `2 (2 block / 1 src: indeed×2)` — the "says 2 blocked but I see 1"
      // report). Surfacing src-count here makes that mismatch obvious without
      // expanding the full JSON and counting sourceIds by hand.
      if (Array.isArray(d.scrapeWarnings) && d.scrapeWarnings.length) {
        const blocks = d.scrapeWarnings.filter(w => w?.severity === 'block');
        const bySource = {};
        for (const w of blocks) { const s = w?.sourceId || '?'; bySource[s] = (bySource[s] || 0) + 1; }
        const srcIds = Object.keys(bySource);
        const breakdown = srcIds.map(s => bySource[s] > 1 ? `${s}×${bySource[s]}` : s).join(',');
        previewParts.push(`warnings: ${d.scrapeWarnings.length} (${blocks.length} block / ${srcIds.length} src${breakdown ? `: ${breakdown}` : ''})`);
      }
      if (Array.isArray(d.imagePaths)) previewParts.push(`imagePaths: ${d.imagePaths.length}`);
      if (Array.isArray(d.images)) previewParts.push(`images: ${d.images.length}`);
      if (d.file) previewParts.push(`file: ${d.file.name || d.file}`);
      if (d.filePath) previewParts.push(`filePath: ${path.basename(String(d.filePath))}`);
      if (d.resumeProfile) previewParts.push('resumeProfile: ✓');
      if (typeof d.matchScore === 'number') previewParts.push(`score: ${d.matchScore}`);
      if (d.url) previewParts.push(`url: ${String(d.url).slice(0, 50)}`);
      if (d.product?.brand) previewParts.push(`brand: ${d.product.brand}`);
      // Marketplace-card surface: status + statusMessage are the most common
      // signal for "why does this card say X?" reports. statusMessage is
      // truncated since the raw text (e.g. an AI error or a multi-URL
      // aggregated reason) can be long. lastChecked is normalized to "Ns ago"
      // so a stale status is obvious without timezone math.
      // jobgroup — the results-tree levels (likelihood band → salary range →
      // role; legacy: category / bucket / branch). Show kind, label, count, and
      // expanded state so the tree's structure / ordering / auto-expand state is
      // readable from Node Diagnostics alone (otherwise these rows are blank and
      // you can only see the node IDs). The label also carries the band's % range
      // and the salary range, so the whole taxonomy is visible here.
      if (d.kind && ['likelihood', 'salary', 'role', 'category', 'bucket', 'branch'].includes(d.kind)) {
        previewParts.push(`${d.kind}: ${d.label || '?'}`);
        if (typeof d.count === 'number') previewParts.push(`count: ${d.count}`);
        previewParts.push(`expanded: ${d.expanded ? 'true' : 'false'}`);
        if (Array.isArray(d.childIds)) previewParts.push(`children: ${d.childIds.length}`);
      }
      // Transient source-progress cards (job + marketplace). Surface the source
      // and its persisted progress status. Only flag a card as lingering once
      // every sibling source card for the same hub is already in a clean
      // terminal state; until then, JobHub intentionally keeps clean cards
      // visible so the source-count set stays intact while other sources are
      // still searching or blocked.
      if (d.sourceId && d.persistedProgress) {
        const p = d.persistedProgress;
        const isCleanTerminal = (p.status === 'skipped' || p.status === 'done') && !p.warning;
        const siblingCards = sourceCardsByHub[d.hubId] || [];
        const allSiblingCardsCleanTerminal = siblingCards.length > 0 && siblingCards.every(card => {
          const siblingProgress = card?.data?.persistedProgress;
          if (!siblingProgress) return false;
          return (siblingProgress.status === 'done' || siblingProgress.status === 'skipped') &&
            !siblingProgress.warning;
        });
        // Only flag as lingering if the auto-dismiss grace window (10s) has
        // clearly elapsed. Cards that completed within the last ~15s are still
        // in the grace period — flagging them is a false positive. doneAt is
        // stamped by JobSourceCardNode on the first terminal state write.
        const DISMISS_GRACE_MS = 15_000; // 10s grace + 5s buffer for render lag
        const gracePeriodElapsed = !p.doneAt || (Date.now() - p.doneAt) > DISMISS_GRACE_MS;
        const lingering = isCleanTerminal && allSiblingCardsCleanTerminal && gracePeriodElapsed;
        previewParts.push(
          `source: ${d.sourceId}, progress: ${p.status || '?'}${p.warning?.code ? ` (${p.warning.code})` : ''}` +
          (lingering ? ' ⚠️ should have auto-dismissed (lingering card)' : ''),
        );
      }
      if (d.platformId) previewParts.push(`platform: ${d.platformId}`);
      if (d.status) previewParts.push(`status: ${d.status}`);
      if (d.statusMessage) previewParts.push(`statusMsg: ${String(d.statusMessage).slice(0, 100)}`);
      if (d.listingUrl) {
        try { previewParts.push(`listingHost: ${new URL(d.listingUrl).host}`); }
        catch { previewParts.push(`listingUrl: ${String(d.listingUrl).slice(0, 40)}`); }
      }
      if (d.lastChecked) {
        const ageS = Math.round((Date.now() - new Date(d.lastChecked).getTime()) / 1000);
        if (Number.isFinite(ageS)) previewParts.push(`checked: ${ageS}s ago`);
      }
      if (Array.isArray(d.attention) && d.attention.length > 0) {
        const high = d.attention.filter(a => a?.urgency === 'high').length;
        previewParts.push(`attention: ${d.attention.length} (${high} high)`);
      }
      if (Array.isArray(d.watchUrls) && d.watchUrls.length > 0) {
        previewParts.push(`watchUrls: ${d.watchUrls.length}`);
      }
      // Per-source ring progress lives in component state, not node data.
      // Compact it as `comp: ebay-sold=done/12,poshmark=searching/0,...` so a
      // "stale ring after re-research" report is diagnosable at a glance.
      const ringProgress = cs.compProgress || cs.sourceProgress;
      if (ringProgress && typeof ringProgress === 'object') {
        const entries = Object.entries(ringProgress);
        if (entries.length > 0) {
          const tag = cs.compProgress ? 'comp' : 'src';
          // Append `[warning-code]` when a source carries a warning so the
          // bug report shows WHY a source ended up skipped/error/empty
          // without requiring the full scrapeWarnings array to be cross-
          // referenced. Format: `linkedin=done/0[http-403]`.
          //
          // When the warning exists but `url` is missing, append `,no-url`.
          // A warning without url means the source card's Solve button
          // can't render — almost always the result of an event-ordering
          // bug like the mid-scrape vs post-completion event split.
          previewParts.push(`${tag}: ` + entries.map(([k, v]) => {
            const base = `${k}=${v?.status || '?'}/${v?.count ?? '?'}`;
            if (!v?.warning?.code) return base;
            const urlTag = v?.url ? '' : ',no-url';
            return `${base}[${v.warning.code}${urlTag}]`;
          }).join(','));
        }
      }
      // SellHub may have early captcha-resolves queued waiting for scrape
      // completion. Surfacing the count turns "I solved all the cards but
      // it still says N left" reports into a one-glance diagnosis ("queued:
      // 1" with hubState=comps-ready means a queued merge didn't drain).
      if (cs.queuedResolvesCount > 0) {
        previewParts.push(`queued: ${cs.queuedResolvesCount}`);
      }
      const dataPreview = previewParts.join(', ');

      return (
        `| \`${shortId(n.id)}\` ` +
        `| ${n.type} ` +
        `| ${n.selected ? '✅' : '—'} ` +
        `| (${n.position?.x?.toFixed(0)}, ${n.position?.y?.toFixed(0)}) ` +
        `| ${n.fontSize ?? '—'}/${n.fontFamily ?? '—'} ` +
        `| ${n.textColor ?? '—'} ` +
        `| ${n.backgroundColor ?? '—'} ` +
        `| ${n.width_prop ?? '—'} ` +
        `| ${n.style_width ?? '—'} ` +
        `| ${n.measured_width ?? '—'} ` +
        `| ${cs.size ?? '—'} ` +
        `| ${flags} ` +
        `| ${dataPreview || '—'} |`
      );
    }).join('\n');
    nodeDiagMarkdown = `
## Node Diagnostics
> **Size columns**: mismatches reveal ResizeObserver/setNodes race conditions.
> **Component state**: React state at the moment the report was generated.

| ID | Type | Selected | Position | Font | T-Color | B-Color | width (prop) | style.width | measured.width | currentSize | state flags | data preview |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
${rows}
${routineOmitted > 0 ? `\n_+ ${routineOmitted} routine jobcard row(s) omitted to preserve the clipboard budget — plain score+url cards with no anomalies (selected/hidden/editing/error); their score/source/role breakdown is in the Taxonomy section above. Anomalous jobcards are always shown._\n` : ''}`;
  }

  // ── Media player state section ────────────────────────────────────────────
  let mediaMarkdown = '';
  if (mediaState && mediaState.length > 0) {
    const READY_STATE = ['HAVE_NOTHING', 'HAVE_METADATA', 'HAVE_CURRENT_DATA', 'HAVE_FUTURE_DATA', 'HAVE_ENOUGH_DATA'];
    const NET_STATE = ['EMPTY', 'IDLE', 'LOADING', 'NO_SOURCE'];
    const fmtRanges = (arr) => {
      if (!arr || arr.length === 0) return '(none)';
      return arr.map(([s, e]) => `${s.toFixed(2)}–${e.toFixed(2)}`).join(', ');
    };
    const rows = mediaState.map((m, i) => {
      const durStr = typeof m.duration === 'number' ? `${m.duration.toFixed(2)}s` : (m.duration || 'unknown');
      const progress = `${m.currentTime?.toFixed(2)}s / ${durStr}`;
      const errorStr = m.errorCode != null ? `code=${m.errorCode} ${m.errorMessage || ''}`.trim() : '—';
      return (
        `| ${i + 1} ` +
        `| ${m.tag} ` +
        `| ${m.paused ? 'paused' : m.ended ? 'ended' : 'playing'} ` +
        `| ${progress} ` +
        `| ${READY_STATE[m.readyState] ?? m.readyState} ` +
        `| ${NET_STATE[m.networkState] ?? m.networkState} ` +
        `| ${fmtRanges(m.seekable)} ` +
        `| ${fmtRanges(m.buffered)} ` +
        `| ${errorStr} |`
      );
    }).join('\n');
    mediaMarkdown = `
## Media Player State
> Snapshot taken at report time. \`readyState\`/\`networkState\` reveal stalls and decode/network issues.
> An empty \`seekable\` range while \`buffered\` is populated means the source isn't Range-capable — timeline clicks are ignored.

| # | Tag | Status | Progress | readyState | networkState | Seekable | Buffered | Error |
|---|---|---|---|---|---|---|---|---|
${rows}
`;
  }

  // ── Image element state section ───────────────────────────────────────────
  // Captures <img> load state at report time. `broken: true` (complete=true,
  // naturalWidth=0) means the protocol returned an error or an undisplayable
  // payload — the primary signature of HEIC / unsupported-format failures.
  let imageMarkdown = '';
  if (imageState && imageState.length > 0) {
    const rows = imageState.map((img, i) => {
      const srcShort = img.src ? img.src.replace(/^local-file:\/\//, '').slice(-60) : '(none)';
      return (
        `| ${i + 1} ` +
        `| ${img.broken ? '⚠️ broken' : img.complete ? 'ok' : 'loading'} ` +
        `| ${img.naturalWidth} × ${img.naturalHeight} ` +
        `| \`...${srcShort}\` |`
      );
    }).join('\n');
    imageMarkdown = `
## Image Element State
> \`broken\` = complete with naturalWidth=0 — protocol returned 4xx/5xx or undisplayable bytes.

| # | Status | Natural Size | src (last 60 chars) |
|---|---|---|---|
${rows}
`;
  }

  // ── Active editable section ────────────────────────────────────────────────
  // Captures the divergence between the focused contenteditable's live DOM
  // text and the saved data.text on its node. A `divergent: true` here is the
  // signature of a "saved while editing — lost my edit" report.
  let activeEditableMarkdown = '';
  if (activeEditableText) {
    const a = activeEditableText;
    activeEditableMarkdown = `
## Active Editable At Report Time
- Editing node: \`${a.editingNodeId || '(unknown)'}\`
- Diverges from saved data.text: ${a.divergent === true ? '⚠️ YES' : a.divergent === false ? 'no' : 'unknown'}
- Live DOM text: \`${(a.liveText || '').replace(/`/g, '\\`')}\`
- Saved data.text: \`${(a.savedText || '').replace(/`/g, '\\`')}\`
`;
  }

  // ── Last save error section ────────────────────────────────────────────────
  // Save errors used to be lost: the toast was shown, the user dismissed it,
  // and the bug report had no record of *why* the save failed. Surfacing this
  // up front means a "Save Failed" report is actionable instead of a guess.
  let lastSaveErrorMarkdown = '';
  if (lastSaveError) {
    lastSaveErrorMarkdown = `
## Last Save Error
- Reason: \`${lastSaveError.reason || 'unknown'}\`
- File: \`${lastSaveError.filePath || '(no current file)'}\`
- When: ${lastSaveError.timestamp || 'unknown'}
`;
  }

  // ── Active IPC tasks ──────────────────────────────────────────────────────
  // Catches the "I clicked Cancel/X but the pipeline kept running" failure
  // mode. The renderer can mark a node visually 'done' instantly, but if the
  // backend AbortControllers weren't cancelled, the underlying tasks finish
  // and overwrite the user's reset. This snapshot makes that immediately
  // diagnosable in any report.
  let activeTasksMarkdown = '';
  try {
    const tasks = snapshotActiveNodeTasks() || [];
    // Only show tasks whose nodeId is in THIS canvas. A node from another
    // canvas window that's actively running is expected and normal — showing
    // it here makes it look like a stuck/leaked task in this canvas when it
    // isn't. Deleted-node tasks (nodeId absent from currentNodeIds but still
    // registered) are the real signal; they're included when they can't be
    // attributed to a foreign canvas via the pipeline telemetry windowId.
    const jobTelWindowId = getJobsTelemetry()?.windowId ?? null;
    const mktTelWindowId = getMarketplaceTelemetry()?.windowId ?? null;
    const knownForeignNodeIds = new Set([
      jobTelWindowId != null && jobTelWindowId !== reportWindowId ? getJobsTelemetry()?.nodeId : null,
      mktTelWindowId != null && mktTelWindowId !== reportWindowId ? getMarketplaceTelemetry()?.nodeId : null,
    ].filter(Boolean));
    const localTasks = tasks.filter(t => !knownForeignNodeIds.has(t.nodeId));
    const foreignCount = tasks.length - localTasks.length;
    if (localTasks.length > 0) {
      const rows = localTasks
        .map(t => `| \`${shortId(t.nodeId)}\` | ${t.taskCount} |`)
        .join('\n');
      activeTasksMarkdown = `
## Active IPC Tasks
> Nodes with backend AbortControllers still registered at report time.
> A node showing tasks here while its UI looks idle means a cancel/abort
> request never reached the backend.${foreignCount > 0 ? ` (${foreignCount} task(s) from other canvas windows omitted.)` : ''}

| Node ID | Active task count |
|---|---|
${rows}
`;
    } else {
      activeTasksMarkdown = `
## Active IPC Tasks
- ✅ None registered${foreignCount > 0 ? ` (${foreignCount} task(s) running in other canvas windows — expected, not shown here)` : ''}.
`;
    }
  } catch { /* never break the report on diagnostic failure */ }

  // ── Build freshness ───────────────────────────────────────────────────────
  // Catches the "I edited a file but the running app still does the old thing"
  // failure mode. Vite hot-reloads the renderer, but Electron main-process
  // files (preload, IPC handlers, settings store) only reload on a full restart.
  // If any tracked source is newer than the process start, the running build is
  // stale — flag it loudly so the report doesn't waste time chasing a phantom.
  const newestSrcMs = getNewestMainProcessSourceMtime();
  const uptimeMs = Math.round(process.uptime() * 1000);
  const startedAt = new Date(PROCESS_START_MS).toISOString();
  const newestSrcStr = newestSrcMs ? new Date(newestSrcMs).toISOString() : '(unknown)';
  const isStale = !!(newestSrcMs && newestSrcMs > PROCESS_START_MS);
  const stalenessLine = !newestSrcMs
    ? '⚠️ **Cannot determine build freshness** — unable to read main-process source file mtimes. If you have edited any Electron main-process files since starting the app, restart before treating this report as authoritative.'
    : isStale
      ? `⚠️ **STALE BUILD**: a tracked main-process source file was modified ${Math.round((newestSrcMs - PROCESS_START_MS) / 1000)}s after the process started. The running app is NOT executing the current source on disk — fully restart Electron (not just Vite) before treating this report as authoritative.`
      : '✅ Up to date — no tracked main-process source has been modified since the process started.';

  // Renderer freshness — the main-process check above never covers src/, but a
  // stale renderer (edited src/ that wasn't re-bundled into dist/) silently runs
  // old UI logic. With a Vite dev server, HMR keeps it current; with the built
  // bundle (loadFile dist/index.html) only a `vite build` updates it.
  const onDevServer = !!process.env.VITE_DEV_SERVER_URL;
  const { src: rSrcMs, bundle: rBundleMs } = getNewestRendererMtimes();
  // A packaged app ships only the built bundle inside app.asar — `src/` isn't on
  // disk, so a null rSrcMs there is EXPECTED (not a read failure). Label it as
  // such only when we DID find the bundle (otherwise we truly know nothing).
  const rSrcStr = rSrcMs
    ? new Date(rSrcMs).toISOString()
    : (rBundleMs ? '(not on disk — packaged build, src/ not shipped)' : '(unknown)');
  const rBundleStr = rBundleMs ? new Date(rBundleMs).toISOString() : '(no built bundle found under dist/)';
  const rendererStale = !!(rSrcMs && rBundleMs && rSrcMs > rBundleMs);
  const bundleAfterStart = !!(rBundleMs && rBundleMs > PROCESS_START_MS);
  let rendererLine;
  if (onDevServer) {
    rendererLine = 'ℹ️ Renderer served by the Vite dev server (HMR) — `src/` edits apply live; the dist/ mtime check does not apply.';
  } else if (rendererStale) {
    rendererLine = `⚠️ **STALE RENDERER**: a \`src/\` file was modified ${Math.round((rSrcMs - rBundleMs) / 1000)}s after the renderer bundle was built. The app loads \`dist/index.html\`, so the running UI does NOT include the latest src/ — run \`vite build\` and reload before trusting renderer behavior (e.g. the AI-scoring / test-mode gate).`;
  } else if (bundleAfterStart) {
    rendererLine = `⚠️ **RENDERER REBUILT MID-SESSION**: dist/ was rebuilt ${Math.round((rBundleMs - PROCESS_START_MS) / 1000)}s after launch but the window may still hold the pre-rebuild bundle — reload the window (or restart) to pick it up.`;
  } else if (rBundleMs) {
    // Bundle present, not newer than src/, and not rebuilt after launch → the
    // window loaded the current on-disk build. src/ being absent (packaged) or
    // older (dev, already rebuilt) both land here — both are fresh.
    rendererLine = rSrcMs
      ? '✅ Renderer bundle (dist/) is at least as new as src/ — running UI matches source.'
      : '✅ Renderer bundle predates process start and no newer src/ is on disk (packaged build) — running the current bundle.';
  } else {
    rendererLine = '⚠️ Cannot determine renderer freshness — no dist/ bundle mtime found.';
  }

  const buildFreshnessMarkdown = `
## Build Freshness
- Main process started: \`${startedAt}\` (uptime ${Math.round(uptimeMs / 1000)}s)
- Newest main-process code mtime (electron/ source + dist-electron/ bundle): \`${newestSrcStr}\`
- ${stalenessLine}
- Newest renderer source mtime (src/): \`${rSrcStr}\`
- Renderer bundle built (dist/ — what loadFile actually serves): \`${rBundleStr}\`
- ${rendererLine}
`;

  // ── Persisted workspace snapshot ──────────────────────────────────────────
  // Reads the on-disk auto-loaded workspace and flags transient hub state that
  // should have been stripped before save. The decisive signal for any "stale
  // state survives restart" report. Never break the report on diagnostic
  // failure — the helper already returns markdown for every error path.
  let persistedWorkspaceMarkdown = '';
  try { persistedWorkspaceMarkdown = buildPersistedWorkspaceSnapshot(frontEndState); }
  catch { /* never break the report on diagnostic failure */ }

  // ── Marketplace session snapshot ──────────────────────────────────────────
  // In-memory session cache (populated by verifyAllPlatforms on startup and
  // by writeStatusCache after each login flow). Truth source for the "Log in"
  // vs "Logged in · refresh" pill in Settings → Marketplace Monitors.
  let marketplaceSessionsMarkdown = '';
  if (hasSellNodes) try {
    const platforms = getSellMonitorPlatforms() || [];
    const cache = getStatusCacheSync();

    // Per-platform verify trace surfaces target URL, final URL, HTTP status, and
    // the first chars of the response body so a "I just logged in but it says
    // false" report shows whether the platform served a soft login wall, a 4xx,
    // or genuinely no auth-redirect. Shared with the job-platform section below.
    const rows = renderSessionRows(platforms, cache);
    const traceBlocks = renderSessionTraceBlocks(platforms, cache);

    marketplaceSessionsMarkdown = `
## Marketplace Sessions
> In-memory session cache — verified fresh on every startup. An entry only
> exists after \`verifyAllPlatforms\` has reached that platform (or after a
> manual \`openLoginWindow\` flow). "No entry" means startup verify hasn't
> finished yet or the platform was skipped. \`false\` with the user reporting
> "I just logged in" points at \`verifySellMonitorLogin\` failing —
> \`bodyHead\` + \`softWallMatch\` in the trace below distinguish
> anti-bot challenges from real login redirects from genuine logout.

| Platform ID | Name | Cached connected | Last confirmed | Last reason |
|---|---|---|---|---|
${rows}

${traceBlocks ? '### Last verify trace per platform\n\n' + traceBlocks + '\n' : ''}`;
  } catch { /* never break the report on diagnostic failure */ }

  // ── Job platform session snapshot ─────────────────────────────────────────
  // Same cache as sell-monitor; shown separately because job platforms have
  // different UI context (Settings → Job Boards). A verify URL returning 404
  // means the platform changed its URL structure — that's only visible here,
  // not in the sell-monitor section above.
  // Only include when this canvas actually has job nodes — don't bleed job
  // login state into a marketplace-only report.
  let jobSessionsMarkdown = '';
  if (hasJobNodes || wantsAuthDiagnostics || isFullReport) try {
    const platforms = getJobLoginPlatforms() || [];
    const cache = getStatusCacheSync();

    const rows = renderSessionRows(platforms, cache);
    const traceBlocks = renderSessionTraceBlocks(platforms, cache);

    jobSessionsMarkdown = `
## Job Platform Sessions
> In-memory session cache for job-board logins — same startup verify as
> marketplace sessions. A verify URL returning 404 means the platform
> changed its URL structure; update \`verifyUrl\` in \`JOB_LOGIN_PLATFORMS\`
> in stealthBrowser.js. "No entry" = startup verify hasn't reached this platform yet.

| Platform ID | Name | Cached connected | Last confirmed | Last reason |
|---|---|---|---|---|
${rows}

${traceBlocks ? '### Last verify trace per platform\n\n' + traceBlocks + '\n' : ''}`;
  } catch { /* never break the report on diagnostic failure */ }

  // ── Login verification timing ─────────────────────────────────────────────
  // Answers "why is login verification slow?" directly, with explicit per-platform
  // verify durations + wall-clock total captured by verifyAllPlatforms. Before
  // this section the only timing signal was subtracting consecutive "Verifying X"
  // / "Startup verify X" main-process log timestamps by hand — and the concurrent
  // verify pool now interleaves those lines, so that method no longer works. This
  // is the first-class replacement: included under FULL or any auth/automation report.
  let verifyTimingMarkdown = '';
  if (isFullReport || wantsAuthDiagnostics || hasSellNodes || hasJobNodes) try {
    const run = getVerifyTimingSummary?.();
    if (run && Array.isArray(run.durations) && run.durations.length > 0) {
      const sumMs = run.durations.reduce((a, d) => a + (d.ms || 0), 0);
      const slowest = run.durations[0]; // durations are pre-sorted slowest-first
      const rows = run.durations.map(d => {
        const result = d.skipped ? 'skipped (login in flight)'
          : d.error ? `error: ${String(d.error).replace(/\|/g, '\\|').slice(0, 80)}`
            : d.connected ? 'connected' : 'not connected';
        return `| \`${d.platformId}\` | ${d.ms} | ${result} |`;
      }).join('\n');
      const savedMs = Math.max(0, sumMs - run.totalMs);
      verifyTimingMarkdown = `
## Login Verification Timing
> Per-platform startup verify durations (\`verifyAllPlatforms\`). Each platform is
> a full page navigation in the shared stealth browser, run through a bounded
> concurrency pool (size ${run.concurrency}) — so wall time is well below the sum
> of per-platform times. A single platform far above the others points at a slow
> TTFB / redirect chain for that site (cookie-consent interstitials, etc.); a high
> WALL total despite low per-platform times points at the pool size (raise
> \`VERIFY_CONCURRENCY\` in accounts.js).

- Run started: \`${new Date(run.startedAt).toISOString()}\`
- Platforms verified: ${run.platformCount}
- Concurrency pool: ${run.concurrency}
- **Wall-clock total: ${run.totalMs}ms** (sum of per-platform: ${sumMs}ms — concurrency saved ~${savedMs}ms)
- Slowest: \`${slowest.platformId}\` at ${slowest.ms}ms

| Platform ID | Verify ms | Result |
|---|---|---|
${rows}
`;
    }
  } catch { /* never break the report on diagnostic failure */ }

  // ── Active auth/login window snapshot ─────────────────────────────────────
  // Login bugs can happen with zero canvas nodes. This captures the visible
  // auth browser mode and current URL/title when the report is taken, which is
  // the decisive signal for Google's "browser or app may not be secure" block.
  let authWindowMarkdown = '';
  // Captcha-resolve windows are a marketplace concern AND a job concern, and a
  // user may describe the failure without auth vocabulary ("window not opening").
  // Include whenever there are automation nodes, or always under FULL.
  if (wantsAuthDiagnostics || isFullReport || hasSellNodes || hasJobNodes) try {
    const diag = getAuthWindowDiagnostics?.();
    const entries = [
      ...(Array.isArray(diag?.active) ? diag.active.map(d => ({ ...d, state: 'active' })) : []),
      diag?.last ? { ...diag.last, state: 'last' } : null,
    ].filter(Boolean);
    if (entries.length > 0) {
      const rows = entries.map(d => {
        const age = d.updatedAt ? `${Math.round((Date.now() - new Date(d.updatedAt).getTime()) / 1000)}s ago` : '—';
        return `| ${d.state} | \`${d.platformId || '—'}\` | ${d.mode || '—'} | \`${String(d.currentUrl || d.loginUrl || '—').replace(/`/g, "'").slice(0, 180)}\` | ${String(d.title || '—').replace(/\|/g, '\\|').slice(0, 80)} | ${d.result || '—'} | ${age} |`;
      }).join('\n');
      const argsRows = entries
        .filter(d => Array.isArray(d.chromeArgs) && d.chromeArgs.length > 0)
        .map(d => `**${d.platformId ?? '?'} (${d.state})**: \`${d.chromeArgs.join(' ')}\``);
      const argsSection = argsRows.length > 0
        ? `\n### Chrome launch args\n${argsRows.join('\n')}\n`
        : '';
      // Resolve outcome — the "why" behind a closed/failed captcha-resolve window,
      // now persisted ON the window record (authWindows.js cleanup) instead of
      // living only in the transient main-log ring buffer. This is what was missing
      // when a SITE_CHANGED auto-close left a window stuck at result=open: the close
      // reason had to be grepped out of Recent Logs, one long-running window away
      // from scrolling out. `closed=site-changed-auto-close` ⇒ stale selectors (the
      // card should offer Retry, not Solve).
      const resolveDiagRows = entries
        .filter(d => d.closeReason || d.extractOutcome || d.siteChangedError)
        .map(d => {
          const bits = [];
          if (d.closeReason) bits.push(`closed=${d.closeReason}`);
          if (d.extractOutcome) bits.push(`extractor=${d.extractOutcome}`);
          if (typeof d.textLen === 'number') bits.push(`textLen=${d.textLen}`);
          bits.push(`saw captcha=${d.sawChallenge ? 'yes' : 'no'} / consent=${d.sawConsent ? 'yes' : 'no'}`);
          if (d.siteChangedError) bits.push(`SITE_CHANGED: ${String(d.siteChangedError).replace(/`/g, "'").replace(/\s+/g, ' ').slice(0, 200)}`);
          return `- **${d.platformId ?? '?'} (${d.state})**: ${bits.join(' · ')}`;
        });
      const resolveDiagSection = resolveDiagRows.length > 0
        ? `\n### Resolve outcome (why the window closed / failed)\n> Persisted on the window record — survives the Recent Logs ring buffer.\n${resolveDiagRows.join('\n')}\n`
        : '';
      // Scrape/stealth browser liveness — a captcha/login window launches a
      // VISIBLE Chrome on the SAME userDataDir, so an alive scrape browser here
      // is the prime suspect for a window that won't open (profile lock). A
      // `launching`/`open` row above with this still 🟢 alive = lock conflict.
      let stealthLine = '';
      try {
        const sb = getStealthBrowserInfo?.() || {};
        const sbAge = sb.launchedAt ? `${Math.round((Date.now() - sb.launchedAt) / 1000)}s ago` : '—';
        stealthLine = `\n- Scrape/stealth browser: ${sb.connected ? `🟢 alive (generation #${sb.generation}, launched ${sbAge}) — holds the shared userDataDir; a window stuck \`launching\` above points at a profile-lock conflict` : '⚪ not running (profile lock free)'}\n`;
      } catch { /* ignore */ }
      authWindowMarkdown = `
## Auth Window Diagnostics
> Snapshot of visible login/captcha windows. \`mode=native-chrome\` means the
> login was launched without Puppeteer/CDP automation so Google SSO should not
> reject it as an unsafe browser. A \`captcha-resolve\` row stuck at
> \`result=launching\` means the visible window never finished opening (hung on
> the profile lock or a macOS permission prompt) — see Recent Logs for the
> 30s launch-timeout error. A row stuck at \`result=open\` with NO matching
> "Resolve outcome" line below AND a live Active IPC Task for the same node is a
> hung resolve: the window's cleanup never resolved its promise (cross-check the
> Active IPC Tasks section).

| State | Platform | Mode | Current/Login URL | Title | Result | Updated |
|---|---|---|---|---|---|---|
${rows}
${stealthLine}${argsSection}${resolveDiagSection}`;
    }
  } catch { /* never break the report on diagnostic failure */ }

  // ── Recent main-process logs ──────────────────────────────────────────────
  // Last ~50 main-process log lines, captured by the in-memory ring buffer
  // in logger.js. Critical for diagnosing "the IPC silently failed" reports:
  // the [Accounts] / [StealthBrowser] / etc. error lines that normally only
  // hit stdout (which users never see) are surfaced here. Skip lines older
  // than this process start so we don't drag in stale logs from a previous
  // run that happened to share the ring buffer state.
  let mainProcessLogLines = [];
  try {
    const logs = (getRecentLogs(60) || []).filter(l => l.ts >= PROCESS_START_MS);
    if (logs.length > 0) {
      mainProcessLogLines = logs.map(l => {
        const t = new Date(l.ts).toISOString().slice(11, 23); // HH:MM:SS.mmm
        const lvl = l.level.toUpperCase().padEnd(5, ' ');
        // Trim each line to a reasonable max so a single fat error doesn't
        // blow the section past the JSON payload's byte budget.
        const msg = (l.message || '').replace(/\r?\n/g, ' ⏎ ').slice(0, 500);
        return `[${t}] ${lvl} ${msg}`;
      });
    }
  } catch { /* never break the report on diagnostic failure */ }
  const mainProcessLogsMarkdown = buildMainProcessLogsMarkdown(mainProcessLogLines);

  // ── AI configuration snapshot ─────────────────────────────────────────────
  // Surfaces missing keys / wrong provider — the most common cause of
  // "I clicked the AI button and nothing happened" reports.
  const aiConfig = buildAIConfigSnapshot();
  // Learned token budgets — observed output (visible+thinking) tokens per task,
  // which drive the self-calibrating max_tokens cap (effectiveCap). A p95 near
  // the 24576 hard cap means a task is truncating and the cap has grown to match.
  const tokenBudgets = (() => { try { return getTokenBudgetSnapshot(); } catch { return {}; } })();
  // The persisted budget store never prunes task keys, so a renamed/removed task
  // lingers as a "ghost" that misleadingly reports a stuck truncation forever.
  // Split live tasks (in the current build's TASK_MODELS/TASK_MAX_TOKENS) from
  // stale ghosts and footnote the ghosts instead of mixing them into the funnel.
  const knownTaskIds = (() => { try { return getKnownTaskIds(); } catch { return null; } })();
  const staleBudgetTasks = knownTaskIds
    ? Object.keys(tokenBudgets).filter(t => !knownTaskIds.has(t)).sort()
    : [];
  // Only surface tasks that have actually truncated — clean tasks are noise for
  // almost every bug report. A footer line summarises how many are healthy so
  // the section doesn't mislead ("only 2 tasks?" when there are really 9).
  const tokenBudgetLines = [];
  let tokenBudgetCleanCount = 0;
  for (const [task, s] of Object.entries(tokenBudgets).sort((a, b) => a[0].localeCompare(b[0]))) {
    if (knownTaskIds && !knownTaskIds.has(task)) continue; // stale ghost — footnoted below
    if (s.truncatedAt <= 0) { tokenBudgetCleanCount++; continue; }
    // Mirrors tokenBudget.js HEADROOM=1.2: truncation floor = truncatedAt × 1.2.
    const nextCapFloor = Math.round(s.truncatedAt * 1.2);
    const seedNote = s.formulaSeedAtTruncation != null ? `formula seed: ${s.formulaSeedAtTruncation}` : '';
    const stuckAtHardCap = s.truncatedAt >= TOKEN_HARD_CAP;
    const healNote = stuckAtHardCap
      ? `⛔ AT hard cap (${TOKEN_HARD_CAP}) — self-calibration cannot self-heal; formula or hard cap must be raised`
      : `next cap ≥${nextCapFloor} — until self-healed this task fell back to a weaker model`;
    const detail = seedNote ? `${seedNote}, ${healNote}` : healNote;
    tokenBudgetLines.push(
      `- \`${task}\`: p95 ${s.p95} / max ${s.max} tok over ${s.samples} call(s)` +
      ` · ⚠️ truncated at cap ${s.truncatedAt} (${detail})`,
    );
  }
  if (tokenBudgetCleanCount > 0) tokenBudgetLines.push(`- *(${tokenBudgetCleanCount} task(s) within budget — not shown)*`);
  if (staleBudgetTasks.length > 0) tokenBudgetLines.push(`- *(${staleBudgetTasks.length} stale/removed task key(s) in the persisted budget store, ignored: ${staleBudgetTasks.join(', ')})*`);
  const tokenBudgetMarkdown = tokenBudgetLines.length
    ? `
### Learned Token Budgets
> Only tasks that have truncated are shown — ⚠️ means a call hit its cap and fell
> back to a weaker model; the cap has since been raised. ⛔ AT hard cap = stuck.
${tokenBudgetLines.join('\n')}`
    : '';

  const aiConfigMarkdown = `
## AI Configuration
- Active provider: \`${aiConfig.provider}\`
- **Active endpoint**: \`${aiConfig.activeEndpoint}\`
- Model selection: \`${aiConfig.modelSelection}\`
- Gemini API key set: ${aiConfig.hasGeminiKey ? '✅' : '❌'}
- Anthropic API key set: ${aiConfig.hasAnthropicKey ? '✅' : '❌'}
- Active key prefix: \`${aiConfig.activeKeyPrefix}\`
- service-account.json configured path: \`${aiConfig.configuredSAPath}\`
- service-account.json resolved path: \`${aiConfig.resolvedSAPath}\`
- service-account.json usable: ${aiConfig.serviceAccountUsable ? '✅' : '❌'}
- **Effectively configured for active provider**: ${aiConfig.effectivelyConfigured ? '✅' : '❌ — AI calls will fail until a key is added in Settings'}
${aiConfig.provider === 'gemini' ? `
### Gemini Telemetry
- Last attempted model: \`${aiConfig.geminiLastAttemptedModel}\`
- Last successful model: \`${aiConfig.geminiLastSuccessfulModel}\`
- Last attempted error: \`${aiConfig.geminiLastAttemptedError}\`
` : ''}${tokenBudgetMarkdown}
`;

  const jobsConfigMarkdown = hasJobNodes ? (() => {
    const jobsConfig = buildJobsConfigSnapshot();
    const tm = jobsConfig.testMode;
    const aiSkipped = (tm && (tm.mode === 'medium' || tm.skipAI));
    // FAST mode is breadth-bounded (queries × pages × jobs-per-page, API per-source)
    // rather than just per-page — spell those bounds out so a tiny count reads as
    // "fast cap", not a scrape miss.
    const fastLine = (tm && tm.mode === 'fast')
      ? `\n- Fast bounds: ${tm.queryCap === Infinity ? '∞' : tm.queryCap} queries × (${tm.jobMaxPages} pages × ${tm.jobPerPageCap} jobs) browser; ≤${tm.apiPerSourceCap === Infinity ? '∞' : tm.apiPerSourceCap}/source API`
      : '';
    const testModeLines = tm
      ? `\n### Job Search Test Mode\n- Mode: **${tm.mode}**${aiSkipped ? ` (${tm.jobPerPageCap} jobs/page, AI skipped)` : ` (${tm.jobPerPageCap} jobs/page, full AI)`}\n- Enabled: ${tm.enabled ? '✅' : '❌'}\n- Scoped source: ${tm.sourceId ? `\`${tm.sourceId}\`` : '*(all sources)*'}\n- Per-page cap: ${tm.jobPerPageCap}, Result cap: ${tm.jobResultCap === Infinity ? 'unlimited' : tm.jobResultCap}${fastLine}`
      : '';
    return `
## Job Search API Configuration
- USAJobs API key set: ${jobsConfig.hasUsajobsKey ? '✅' : '❌'}
- USAJobs Email set: ${jobsConfig.hasUsajobsEmail ? '✅' : '❌'}
- USAJobs key prefix: \`${jobsConfig.usajobsKeyPrefix}\`
- Scrapfly API key set: ${jobsConfig.hasScrapflyKey ? '✅' : '❌'}
- Scrapfly key prefix: \`${jobsConfig.scrapflyKeyPrefix}\`${testModeLines}
`;
  })() : '';

  // The node ids in THIS report's canvas — lets the pipeline snapshots flag a
  // funnel whose originating node isn't here (the main-process telemetry is
  // shared across all open windows/canvases, so it may be another canvas's run).
  const currentNodeIds = new Set((nodes || []).map(n => n?.id).filter(Boolean));

  const canvasFilePath = frontEndState?.currentFile || frontEndState?.settings?.lastOpenedWorkspace || null;
  let jobsPipelineMarkdown = '';
  try { jobsPipelineMarkdown = buildJobsPipelineSnapshot(currentNodeIds, reportWindowId, canvasFilePath); }
  catch { /* never break the report on diagnostic failure */ }

  let marketplacePipelineMarkdown = '';
  try { marketplacePipelineMarkdown = buildMarketplacePipelineSnapshot(currentNodeIds, reportWindowId); }
  catch { /* never break the report on diagnostic failure */ }

  let scraperAdaptationMarkdown = '';
  if (hasJobNodes || hasSellNodes) try { scraperAdaptationMarkdown = buildScraperAdaptationSnapshot(); }
    catch { /* never break the report on diagnostic failure */ }

  let issueReporterDraftMarkdown = '';
  if (payload.issueReporterDraft) {
    const d = payload.issueReporterDraft;
    const lsLine = d.localStorageError
      ? `Error: ${d.localStorageError}`
      : d.localStoragePresent
        ? `Present (length: ${d.localStorageLength}, prefix: \`${d.localStoragePrefix}\`)`
        : 'None';
    const ssLine = d.sessionStorageError
      ? `Error: ${d.sessionStorageError}`
      : d.sessionStoragePresent
        ? `Present (length: ${d.sessionStorageLength}, prefix: \`${d.sessionStoragePrefix}\`)`
        : 'None';

    issueReporterDraftMarkdown = `
## Issue Reporter Draft State
- LocalStorage legacy draft: \`${lsLine}\`
- SessionStorage draft (current session): \`${ssLine}\`
`;
  }

  // ── Viewport section ───────────────────────────────────────────────────────
  const vp = frontEndState?.viewport;
  const viewportLine = vp ? `- Viewport: zoom=${vp.zoom} x=${vp.x} y=${vp.y}` : '';


  let baseMarkdown = `At the end of your debug, assess whether new bug reporting filter codes need to be implemented (which will all be included in the "FULL" filter code). This occurs when even if the user used the "FULL" filter code, it would not have been enough reporting data to debug this issue smoothly.

# Bug Report

## Issue Description
${description}
${payload.filterCode ? `\n**Filter code applied:** \`${payload.filterCode}\`${payload.filterStats ? ` — event log trimmed to ${payload.filterStats.eventsShown} of ${payload.filterStats.eventsTotal} line(s) (matched categories + nearby context)${payload.filterStats.omittedSections?.length ? `; sections omitted: ${payload.filterStats.omittedSections.join(', ')}` : ''}.` : '.'}\n*This is a filtered view — events outside the matched categories were dropped. Ask the user to re-export with code \`FULL\` if the timeline looks incomplete.*` : ''}

## Application State Summary
- Nodes: ${sectionOmitted('nodes') ? '*(omitted by filter code)*' : (nodes ? nodes.length : 0)}
- Edges: ${sectionOmitted('edges') ? '*(omitted by filter code)*' : (edges ? edges.length : 0)}
- Drawings: ${sectionOmitted('drawings') ? '*(omitted by filter code)*' : (drawings ? drawings.length : 0)}
- Active Tool: ${frontEndState?.activeTool || 'None'}
- OS: ${systemInfo.platform} ${systemInfo.arch}
${viewportLine}
${buildFreshnessMarkdown}${persistedWorkspaceMarkdown}${activeTasksMarkdown}${aiConfigMarkdown}${jobsConfigMarkdown}${jobsPipelineMarkdown}${issueReporterDraftMarkdown}${marketplacePipelineMarkdown}${marketplaceSessionsMarkdown}${jobSessionsMarkdown}${verifyTimingMarkdown}${authWindowMarkdown}${scraperAdaptationMarkdown}${activeEditableMarkdown}${lastSaveErrorMarkdown}${nodeDiagMarkdown}${mediaMarkdown}${imageMarkdown}
`;

  // Static safety bound (not adaptive): keeps the assembled bug-report payload
  // from ballooning past what's reasonable to ship/store.
  const MAX_BUDGET_BYTES = 10 * 1024 * 1024; // 10MB
  const bufferBytes = Buffer.byteLength(baseMarkdown, 'utf8');
  const events = payload.eventLogs || [];
  const remainingBytes = MAX_BUDGET_BYTES - bufferBytes;

  let includedEventLines = [];
  let trimmedEventsMarkdown = '';
  if (remainingBytes > 0 && events.length > 0) {
    const eventsBlockOpen = `\`\`\`text\n`;
    const eventsBlockClose = `\n\`\`\`\n`;
    let eventsBytes = Buffer.byteLength(eventsBlockOpen) + Buffer.byteLength(eventsBlockClose);

    for (let i = events.length - 1; i >= 0; i--) {
      const eventLine = String(events[i]);
      const eventStr = eventLine + '\n';
      const eventBytes = Buffer.byteLength(eventStr, 'utf8');
      if (eventsBytes + eventBytes < remainingBytes) {
        eventsBytes += eventBytes;
        includedEventLines.push(eventLine);
      } else {
        break;
      }
    }
    includedEventLines.reverse(); // restore chronological order

    trimmedEventsMarkdown = buildFencedTextBlock(includedEventLines, '*(No events recorded)*');
  } else if (remainingBytes <= 0) {
    trimmedEventsMarkdown = `*(Event history omitted due to size limit)*\n`;
  } else {
    trimmedEventsMarkdown = `*(No events recorded)*\n`;
  }

  // Logs and the Event History heading live outside baseMarkdown so the
  // clipboard path (enforceClipboardMarkdownCap) can trim them independently.
  const fullMarkdown = baseMarkdown + mainProcessLogsMarkdown + '\n## Event History\n' + trimmedEventsMarkdown;
  if (options?.maxChars) {
    return enforceClipboardMarkdownCap(baseMarkdown, includedEventLines, mainProcessLogLines, options.maxChars);
  }
  return { markdown: fullMarkdown, truncated: false, trimmedEventCount: 0, trimmedLogCount: 0, hardTruncated: false };
}

// ── IPC handlers ──────────────────────────────────────────────────────────────
export function registerBugReportHandlers() {

  // Save report to a file chosen by the user via a native save dialog.
  handleSafe('export-bug-report', async (event, payload) => {
    const { markdown: markdownContent } = generateMarkdown(payload, event.sender?.id ?? null);

    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Save Bug Report',
      defaultPath: path.join(app.getPath('desktop'), `bug_report_${Date.now()}.md`),
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });

    if (canceled || !filePath) return { success: false, canceled: true };

    await fs.promises.writeFile(filePath, markdownContent, 'utf8');
    return { filePath };
  });

  // Return the report as a string so the renderer can copy it to the clipboard.
  // No file dialog, no disk I/O — just generate and return the markdown.
  handleSafe('generate-bug-report-markdown', async (event, payload) => {
    return generateMarkdown(payload, event.sender?.id ?? null, { maxChars: CLIPBOARD_BUG_REPORT_MAX_CHARS });
  });
}
