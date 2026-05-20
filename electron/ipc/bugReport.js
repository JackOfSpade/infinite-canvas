import electronPkg from 'electron';
const { dialog, app } = electronPkg;
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { handleSafe, snapshotActiveNodeTasks } from './ipcUtils.js';
import { getAISettings, resolveServiceAccountPath, getJobsSettings } from './settings.js';
import { getSellMonitorPlatforms } from './stealthBrowser.js';
import { getRecentLogs } from '../logger.js';
import { getGeminiTelemetry } from './gemini.js';
import { getJobsTelemetry } from './jobs.js';
import { getMarketplaceTelemetry } from './marketplace.js';

// Captured at module load: the moment this code first ran in the main process.
// Used to detect when a user edits a source file but forgets to restart
// Electron — the renderer hot-reloads via Vite but the main-process modules
// keep running the old code, producing the maddening "I changed it, why isn't
// it doing the new thing?" failure mode.
const PROCESS_START_MS = Date.now();

/**
 * Returns the mtime (ms) of the newest main-process .js file actually running,
 * or null if scanning fails. We scan the directory that contains the running
 * module — in dev that's electron/ipc/, in production that's dist-electron/
 * (vite-plugin-electron emits hashed chunks like `settings-D7wn9ttr.js`, so
 * the old hardcoded-filename approach silently returned null in any built
 * app, producing the false "Up to date" claim that masked stale-build bugs).
 *
 * Comparing the newest mtime to PROCESS_START_MS tells us if any file has
 * been rewritten since the process booted — the signal we actually want.
 */
function getNewestMainProcessSourceMtime() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    // Scan `here` and one level up — covers both `dist-electron/` (flat) and
    // `electron/ipc/` (which has main.js and preload.js one level up in dev).
    const dirs = [here, path.join(here, '..')];
    let newest = 0;
    for (const dir of dirs) {
      let entries = [];
      try { entries = fs.readdirSync(dir); } catch { continue; }
      for (const name of entries) {
        if (!name.endsWith('.js')) continue;
        try {
          const stat = fs.statSync(path.join(dir, name));
          if (stat.isFile() && stat.mtimeMs > newest) newest = stat.mtimeMs;
        } catch { /* skip */ }
      }
    }
    return newest || null;
  } catch {
    return null;
  }
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
  // a service-account is resolvable, and Mock Mode otherwise. Surfacing the
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
    activeEndpoint = 'Mock Mode (placeholder data)';
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

function buildJobsConfigSnapshot() {
  let jobs = {};
  try { jobs = getJobsSettings() || {}; } catch { /* settings store may not be ready */ }

  const usajobsKey = jobs.usajobsApiKey;
  const usajobsEmail = jobs.usajobsEmail;
  const keyPrefix = usajobsKey ? `${String(usajobsKey).slice(0, 5)}…` : '(none)';

  return {
    hasUsajobsKey: !!usajobsKey,
    hasUsajobsEmail: !!usajobsEmail,
    usajobsKeyPrefix: keyPrefix,
  };
}

/**
 * Renders the last job-search pipeline funnel (search → scoring → bucketing).
 *
 * This is the load-bearing section for "did we analyze all the jobs we found?"
 * reports. The in-memory node tallies that would otherwise answer it
 * (totalScoredCount / finalSourceCounts on the hub) evaporate the moment the
 * user deletes the hub — which is exactly when these reports get filed — and
 * the raw funnel numbers otherwise live only in the 60-line log ring buffer,
 * which scrolls. getJobsTelemetry() captures them in the main process so they
 * survive both.
 *
 * Crucially, it separates *expected* drops (dedup / too-old / already-seen
 * history) from *unexpected* losses: jobs that reached the scorer but came
 * back as placeholder filler (matchScore=50, "AI format error"), and jobs the
 * abort signal cut off before they were ever scored. A bare "Scored N jobs"
 * log line hides both.
 */
function buildJobsPipelineSnapshot() {
  let t;
  try { t = getJobsTelemetry(); } catch { return ''; }
  const hasResolves = t && t.resolves && Object.keys(t.resolves).length > 0;
  if (!t || (!t.search && !hasResolves && !t.scoring && !t.bucketing)) return '';

  const ago = (ts) => {
    if (!ts) return '';
    const s = Math.round((Date.now() - ts) / 1000);
    return Number.isFinite(s) ? ` (${s}s ago)` : '';
  };

  const lines = [];

  if (t.search) {
    const s = t.search;
    lines.push(`### Search${ago(s.ts)}`);
    lines.push(`- Queries: ${s.queries}`);
    lines.push(
      `- Found (raw): ${s.raw} → deduped ${s.deduped} → age-dropped ${s.ageDropped} → ` +
      `already-seen/history ${s.historyDropped} → **new: ${s.kept}**`,
    );
    lines.push('- _(dedup / age / history drops are by-design — not jobs we failed to analyze)_');
  } else {
    lines.push('### Search\n- (no search recorded this session — e.g. scoring resumed from a captcha-resolve)');
  }

  // Captcha-resolve / Solve path. Indeed (and other captcha-walled sources)
  // only ever reach scoring through here, so this is where their "found →
  // analyzed" accounting lives — and the line a "did we re-show old jobs?"
  // report turns on. historyDropped>0 with kept=0 is the healthy answer to
  // "I solved the captcha again and saw the same jobs": now they're suppressed.
  if (hasResolves) {
    // One line per resolved source (newest first) so a multi-source recovery
    // — e.g. Indeed then LinkedIn — shows every resolve, not just the last.
    const entries = Object.entries(t.resolves).sort((a, b) => (b[1]?.ts || 0) - (a[1]?.ts || 0));
    lines.push('\n### Captcha-resolve / Solve');
    for (const [sourceId, r] of entries) {
      lines.push(
        `- \`${sourceId}\`${ago(r.ts)}: inline-extracted ${r.extracted} → age-dropped ${r.ageDropped} → ` +
        `already-seen/history ${r.historyDropped} → **new: ${r.kept}**`,
      );
      if (r.extracted > 0 && r.kept === 0) {
        lines.push('  - _(every extracted job was already shown on a prior run — correctly suppressed, not re-analyzed)_');
      }
    }
  }

  if (t.scoring) {
    const s = t.scoring;
    const clean = s.placeholders === 0 && s.unscored === 0;
    lines.push(`\n### Scoring${ago(s.ts)}`);
    lines.push(`- Input: ${s.input} → scored: ${s.scored} ${clean ? '✅ all genuinely analyzed' : ''}`);
    lines.push(`- Batches: ${s.batches} (${s.failedBatches} failed)`);
    if (s.placeholders > 0) {
      lines.push(`- ⚠️ **${s.placeholders} placeholder score(s)** — these jobs reached the scorer but came back unusable and were given a default matchScore=50. They were NOT genuinely analyzed.`);
    }
    if (s.unscored > 0) {
      lines.push(`- ⚠️ **${s.unscored} job(s) never scored** — the abort signal cut the batch loop short before they were sent to the scorer.`);
    }
  } else {
    lines.push('\n### Scoring\n- (no scoring recorded this session)');
  }

  if (t.bucketing) {
    const b = t.bucketing;
    lines.push(`\n### Bucketing${ago(b.ts)}`);
    lines.push(`- Input: ${b.input} → categories: ${b.categories}`);
    if (b.categories === 0 && b.input > 0) {
      lines.push('- ⚠️ Bucketing returned 0 categories — the renderer will have fallen back to a flat spawn (jobs still shown, but the category/salary tree is lost).');
    }
  } else {
    lines.push('\n### Bucketing\n- (no bucketing recorded this session)');
  }

  return `
## Job Search Pipeline
> Last run's funnel, captured in the main process so it survives hub deletion
> and log-buffer scroll. The "found → analyzed" gap answers "did we analyze all
> the jobs?": dedup / age / already-seen drops are expected; placeholder or
> unscored jobs are not. Each stage stamps independently — a captcha-resolve
> can score pending jobs with no fresh search this session.

${lines.join('\n')}
`;
}

/**
 * Sell-side analog of buildJobsPipelineSnapshot: renders the last marketplace
 * pipeline funnel (photo analysis → comp scrape → captcha-resolve → price
 * synthesis → platform fit). Same rationale — the SellHub's in-memory tallies
 * vanish when the hub is deleted, and the raw funnel otherwise lives only in
 * the scrolling log buffer. The decisive line for "did we use all the comps we
 * found?" is synthesis's used-vs-found gap (the top-25/15 slice is by-design;
 * a recommended_price of null means comps were scraped but no price came out).
 */
function buildMarketplacePipelineSnapshot() {
  let t;
  try { t = getMarketplaceTelemetry(); } catch { return ''; }
  const hasResolves = t && t.resolves && Object.keys(t.resolves).length > 0;
  if (!t || (!t.analyze && !t.scrape && !hasResolves && !t.synthesis && !t.fit)) return '';

  const ago = (ts) => {
    if (!ts) return '';
    const s = Math.round((Date.now() - ts) / 1000);
    return Number.isFinite(s) ? ` (${s}s ago)` : '';
  };

  const lines = [];

  if (t.analyze) {
    const a = t.analyze;
    lines.push(`### Product analysis${ago(a.ts)}`);
    lines.push(`- ${a.photos} photo(s) → "${a.title}"${a.mock ? ' ⚠️ **mock mode** (AI not configured — placeholder product)' : ''}`);
  }

  if (t.scrape) {
    const s = t.scrape;
    lines.push(`\n### Comp scrape${ago(s.ts)}`);
    lines.push(`- ${s.sources} sources → **${s.sold} sold + ${s.active} active** comps · ${s.warnings} warning(s)${s.blocked > 0 ? `, ${s.blocked} block-severity` : ''}`);
    if (s.blocked > 0) {
      lines.push('- _(blocked sources contribute 0 comps until solved via the card\'s Solve button — see the resolve stage / Recent Logs)_');
    }
  }

  if (hasResolves) {
    // One line per resolved source (newest first) so a multi-source recovery
    // — e.g. Mercari then eBay — shows every resolve, not just the last.
    const entries = Object.entries(t.resolves).sort((a, b) => (b[1]?.ts || 0) - (a[1]?.ts || 0));
    lines.push('\n### Captcha-resolve / Solve');
    for (const [sourceId, r] of entries) {
      lines.push(`- \`${sourceId}\`${ago(r.ts)}: inline-extracted ${r.extracted} ${r.category} comp(s) merged into the pricing set`);
    }
  }

  if (t.synthesis) {
    const s = t.synthesis;
    lines.push(`\n### Price synthesis${ago(s.ts)}`);
    if (s.soldFound + s.activeFound === 0) {
      lines.push('- ⚠️ 0 comps available → no price synthesized (all sources empty or blocked).');
    } else {
      const capped = s.soldFound > s.soldUsed || s.activeFound > s.activeUsed;
      lines.push(
        `- Comps fed to the model: ${s.soldUsed}/${s.soldFound} sold + ${s.activeUsed}/${s.activeFound} active` +
        (capped ? ' _(capped at the top 25 sold / 15 active by title-match — by-design, not lost data)_' : ''),
      );
      lines.push(`- Result: recommended_price=${s.recommendedPrice == null ? '**null** ⚠️ (comps scraped but no price produced)' : '$' + s.recommendedPrice}, match_quality=${s.matchQuality}`);
    }
  }

  if (t.fit) {
    const f = t.fit;
    lines.push(`\n### Platform fit${ago(f.ts)}`);
    lines.push(`- ${f.platforms} platform(s) → ${f.good} good / ${f.unfit} unfit`);
  }

  return `
## Marketplace Pipeline
> Last sell-side run's funnel (photo analysis → comp scrape → price synthesis →
> platform fit), captured in the main process so it survives SellHub deletion
> and log-buffer scroll — the sell-side analog of the Job Search Pipeline. The
> "found → fed to the model" gap in synthesis answers "did we use all the comps
> we found?": the top-25/15 cap is by-design; blocked sources and a null price
> are not. Each stage stamps independently (a resolve/rescrape can run alone).

${lines.join('\n')}
`;
}

// Mid-run hubStates that should NEVER survive to disk — they are single-session
// pipeline state. Alongside the data keys checked inline below (errorMessage,
// isRateLimit, scrapeWarnings, pendingJobs, pendingTargetRole) these are exactly
// what sanitizeNodesForSave strips; if any show up in the PERSISTED workspace
// file the auto-loaded canvas replays them on every restart. Kept in sync with
// sanitizeNodesForSave in serializationUtils.js.
const PERSISTED_TRANSIENT_HUB_STATES = ['parsing', 'querying', 'searching', 'scoring', 'analyzing', 'researching'];

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
        if (PERSISTED_TRANSIENT_HUB_STATES.includes(d.hubState)) hits.push(`hubState=${d.hubState}`);
        if (d.errorMessage) hits.push(`errorMessage="${String(d.errorMessage).slice(0, 60)}"`);
        if (d.isRateLimit) hits.push('isRateLimit=true');
        if (Array.isArray(d.scrapeWarnings) && d.scrapeWarnings.length) hits.push(`scrapeWarnings=${d.scrapeWarnings.length}`);
        if (Array.isArray(d.pendingJobs) && d.pendingJobs.length) hits.push(`pendingJobs=${d.pendingJobs.length}`);
        if ('pendingTargetRole' in d && d.pendingTargetRole) hits.push('pendingTargetRole=set');
        if (hits.length) offenders.push(`  - \`${String(n.id).slice(0, 8)}\` (${n.type}): ${hits.join(', ')}`);
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
export function generateMarkdown(payload) {
  const { description, nodes, edges, drawings, frontEndState, nodeInternals, nodeComponentStates, mediaState, imageState, lastSaveError, activeEditableText } = payload;

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

  const appState = {
    systemInfo,
    frontEndState,
    nodes,
    edges,
    drawings,
    timestamp: new Date().toISOString(),
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

  let nodeDiagMarkdown = '';
  if (nodeInternals && nodeInternals.length > 0) {
    const rows = nodeInternals.map(n => {
      const cs = compStateById[n.id] || {};
      const flags = [
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
      if (d.url) previewParts.push(`url: ${String(d.url).slice(0, 50)}`);
      if (d.product?.brand) previewParts.push(`brand: ${d.product.brand}`);
      // Marketplace-card surface: status + statusMessage are the most common
      // signal for "why does this card say X?" reports. statusMessage is
      // truncated since the raw text (e.g. an AI error or a multi-URL
      // aggregated reason) can be long. lastChecked is normalized to "Ns ago"
      // so a stale status is obvious without timezone math.
      // jobgroup (category / salary bucket) — show kind, label, count, and
      // expanded state so "why is this empty?" or "why won't it collapse?"
      // reports are diagnosable at a glance.
      if (d.kind && (d.kind === 'category' || d.kind === 'bucket')) {
        previewParts.push(`${d.kind}: ${d.label || '?'}`);
        if (typeof d.count === 'number') previewParts.push(`count: ${d.count}`);
        previewParts.push(`expanded: ${d.expanded ? 'true' : 'false'}`);
        if (Array.isArray(d.childIds)) previewParts.push(`children: ${d.childIds.length}`);
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
      // Mock-mode flag is set by gemini.js when AI wasn't configured at call
      // time. Surfacing it here turns "why is the product info wrong?" reports
      // into a one-glance diagnosis.
      if (d.product?._mockMode) previewParts.push('⚠️ mockMode: true');
      if (d.resumeProfile?._mockMode) previewParts.push('⚠️ resume._mockMode: true');
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
        `| \`${n.id.slice(0, 8)}\` ` +
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

| ID (first 8) | Type | Selected | Position | Font | T-Color | B-Color | width (prop) | style.width | measured.width | currentSize | state flags | data preview |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
${rows}
`;
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
    if (tasks.length > 0) {
      const rows = tasks
        .map(t => `| \`${String(t.nodeId).slice(0, 8)}\` | ${t.taskCount} |`)
        .join('\n');
      activeTasksMarkdown = `
## Active IPC Tasks
> Nodes with backend AbortControllers still registered at report time.
> A node showing tasks here while its UI looks idle means a cancel/abort
> request never reached the backend.

| Node ID (first 8) | Active task count |
|---|---|
${rows}
`;
    } else {
      activeTasksMarkdown = `
## Active IPC Tasks
- ✅ None registered.
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
  const stalenessLine = isStale
    ? `⚠️ **STALE BUILD**: a tracked main-process source file was modified ${Math.round((newestSrcMs - PROCESS_START_MS) / 1000)}s after the process started. The running app is NOT executing the current source on disk — fully restart Electron (not just Vite) before treating this report as authoritative.`
    : '✅ Up to date — no tracked main-process source has been modified since the process started.';
  const buildFreshnessMarkdown = `
## Build Freshness
- Main process started: \`${startedAt}\` (uptime ${Math.round(uptimeMs / 1000)}s)
- Newest tracked source file mtime: \`${newestSrcStr}\`
- ${stalenessLine}
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
  // Disk cache (session-status-cache.json, written by accounts.js after a
  // verified openLoginWindow flow) is the truth source for the "Log in" vs
  // "Logged in · refresh" pill in Settings → Marketplace Monitors. When the
  // pill says one thing and the user expects the other, this section is what
  // confirms which of the two is wrong — without it, the bug is invisible
  // to anyone reading the report later.
  let marketplaceSessionsMarkdown = '';
  try {
    const platforms = getSellMonitorPlatforms() || [];
    const cachePath = path.join(app.getPath('userData'), 'session-status-cache.json');
    let cache = {};
    try {
      const raw = fs.readFileSync(cachePath, 'utf8');
      cache = JSON.parse(raw) || {};
    } catch { /* file may not exist yet — empty cache is fine */ }

    const rows = platforms.map(p => {
      const entry = cache[p.id];
      const connected = entry?.connected ? '✅ true' : entry ? '❌ false' : '— (no entry)';
      const lastConfirmed = entry?.ts
        ? `${new Date(entry.ts).toISOString()} (${Math.round((Date.now() - entry.ts) / 1000)}s ago)`
        : '—';
      const reason = entry?.lastReason ? entry.lastReason.replace(/\|/g, '\\|') : '—';
      return `| \`${p.id}\` | ${p.name} | ${connected} | ${lastConfirmed} | ${reason} |`;
    }).join('\n');

    // Per-platform verify trace — only included when the cache has a trace
    // (i.e. verifier has run at least once). Surfaces target URL, final URL,
    // HTTP status, and the first chars of the response body so a "I just
    // logged in but it says false" report immediately shows whether eBay
    // served a soft login wall, a 4xx, or genuinely no auth-redirect.
    const traceBlocks = platforms.map(p => {
      const t = cache[p.id]?.lastTrace;
      if (!t) return '';
      const lines = [
        `**${p.name}** (\`${p.id}\`):`,
        `  - target: \`${t.target || '—'}\``,
        t.finalUrl != null ? `  - finalUrl: \`${t.finalUrl}\`` : null,
        t.status != null ? `  - HTTP status: \`${t.status}\`` : null,
        t.htmlBytes != null ? `  - htmlBytes: \`${t.htmlBytes}\`` : null,
        t.softWallMatch ? `  - softWallMatch: \`${t.softWallMatch}\`` : null,
        t.error ? `  - error: \`${t.error}\`` : null,
        t.bodyHead ? `  - bodyHead: \`${t.bodyHead.replace(/`/g, "'").slice(0, 240)}\`` : null,
      ].filter(Boolean);
      return lines.join('\n');
    }).filter(Boolean).join('\n\n');

    marketplaceSessionsMarkdown = `
## Marketplace Sessions
> Disk cache state (\`session-status-cache.json\`) — the only source of truth
> for the "Logged in" pill in Settings. An entry only exists after a
> verified \`openLoginWindow\` flow; "no entry" means we never confirmed a
> login for that platform. Stale entries (large "ago" with the user
> reporting a logged-out experience) point at cookie expiry; \`false\` with
> the user reporting "I just logged in" points at \`verifySellMonitorLogin\`
> failing — \`bodyHead\` + \`softWallMatch\` in the trace below distinguish
> anti-bot challenges from real login redirects from genuine logout.

| Platform ID | Name | Cached connected | Last confirmed | Last reason |
|---|---|---|---|---|
${rows}

${traceBlocks ? '### Last verify trace per platform\n\n' + traceBlocks + '\n' : ''}
- Cache file: \`${cachePath}\`
`;
  } catch { /* never break the report on diagnostic failure */ }

  // ── Recent main-process logs ──────────────────────────────────────────────
  // Last ~50 main-process log lines, captured by the in-memory ring buffer
  // in logger.js. Critical for diagnosing "the IPC silently failed" reports:
  // the [Accounts] / [StealthBrowser] / etc. error lines that normally only
  // hit stdout (which users never see) are surfaced here. Skip lines older
  // than this process start so we don't drag in stale logs from a previous
  // run that happened to share the ring buffer state.
  let mainProcessLogsMarkdown = '';
  try {
    const logs = (getRecentLogs(60) || []).filter(l => l.ts >= PROCESS_START_MS);
    if (logs.length > 0) {
      const formatted = logs.map(l => {
        const t = new Date(l.ts).toISOString().slice(11, 23); // HH:MM:SS.mmm
        const lvl = l.level.toUpperCase().padEnd(5, ' ');
        // Trim each line to a reasonable max so a single fat error doesn't
        // blow the section past the JSON payload's byte budget.
        const msg = (l.message || '').replace(/\r?\n/g, ' ⏎ ').slice(0, 500);
        return `[${t}] ${lvl} ${msg}`;
      }).join('\n');
      mainProcessLogsMarkdown = `
## Recent Main-Process Logs
> Last ~60 lines from the main process's logger (ring buffer). Use this to
> see what \`[Accounts]\` / \`[StealthBrowser]\` / \`[Marketplace]\` actually
> did and any errors that were swallowed by an IPC handler before the
> renderer got a useful response.

\`\`\`
${formatted}
\`\`\`
`;
    }
  } catch { /* never break the report on diagnostic failure */ }

  // ── AI configuration snapshot ─────────────────────────────────────────────
  // Surfaces missing keys / wrong provider — the most common cause of
  // "I clicked the AI button and nothing happened" reports.
  const aiConfig = buildAIConfigSnapshot();
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
- **Effectively configured for active provider**: ${aiConfig.effectivelyConfigured ? '✅' : '❌ — AI calls will fall back to Mock Mode (Gemini) or fail (Claude) until a key is added in Settings'}
${aiConfig.provider === 'gemini' ? `
### Gemini Telemetry
- Last attempted model: \`${aiConfig.geminiLastAttemptedModel}\`
- Last successful model: \`${aiConfig.geminiLastSuccessfulModel}\`
- Last attempted error: \`${aiConfig.geminiLastAttemptedError}\`
` : ''}
`;

  const jobsConfig = buildJobsConfigSnapshot();
  const jobsConfigMarkdown = `
## Job Search API Configuration
- USAJobs API key set: ${jobsConfig.hasUsajobsKey ? '✅' : '❌'}
- USAJobs Email set: ${jobsConfig.hasUsajobsEmail ? '✅' : '❌'}
- USAJobs key prefix: \`${jobsConfig.usajobsKeyPrefix}\`
`;

  let jobsPipelineMarkdown = '';
  try { jobsPipelineMarkdown = buildJobsPipelineSnapshot(); }
  catch { /* never break the report on diagnostic failure */ }

  let marketplacePipelineMarkdown = '';
  try { marketplacePipelineMarkdown = buildMarketplacePipelineSnapshot(); }
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

  const STATE_BUDGET_BYTES = 1024 * 1024; // 1MB budget for the JSON state block
  let appStateJson = JSON.stringify(appState, null, 2);
  let stateWasTrimmed = false;

  if (Buffer.byteLength(appStateJson, 'utf8') > STATE_BUDGET_BYTES) {
    // If the full state is too large, it's almost always due to thousands of drawing points.
    // Omit the drawings but keep the rest of the metadata.
    const { drawings: _drawings, ...trimmedAppState } = appState;
    appStateJson = JSON.stringify(trimmedAppState, null, 2);
    stateWasTrimmed = true;
  }

  let baseMarkdown = `Do not change the bug report feature, just what it reports. First assess if this bug report has all the data you need to debug this. If not, improve the reporting. Then, fix the following bug:

# Bug Report

## Issue Description
${description}

## Application State Summary
- Nodes: ${nodes ? nodes.length : 0}
- Edges: ${edges ? edges.length : 0}
- Drawings: ${drawings ? drawings.length : 0} ${stateWasTrimmed ? '*(Omitted from JSON below due to size)*' : ''}
- Active Tool: ${frontEndState?.activeTool || 'None'}
- OS: ${systemInfo.platform} ${systemInfo.arch}
${viewportLine}
${buildFreshnessMarkdown}${persistedWorkspaceMarkdown}${activeTasksMarkdown}${aiConfigMarkdown}${jobsConfigMarkdown}${jobsPipelineMarkdown}${issueReporterDraftMarkdown}${marketplacePipelineMarkdown}${marketplaceSessionsMarkdown}${mainProcessLogsMarkdown}${activeEditableMarkdown}${lastSaveErrorMarkdown}${nodeDiagMarkdown}${mediaMarkdown}${imageMarkdown}
<details>
<summary><b>Click here to expand the full JSON Application State</b></summary>

\`\`\`json
${appStateJson}
\`\`\`

</details>

## Event History
`;

  const MAX_BUDGET_BYTES = 10 * 1024 * 1024; // 10MB
  const bufferBytes = Buffer.byteLength(baseMarkdown, 'utf8');
  const events = payload.eventLogs || [];
  const remainingBytes = MAX_BUDGET_BYTES - bufferBytes;

  let trimmedEventsMarkdown = '';
  if (remainingBytes > 0 && events.length > 0) {
    const eventsBlockOpen = `\`\`\`text\n`;
    const eventsBlockClose = `\n\`\`\`\n`;
    let eventsBytes = Buffer.byteLength(eventsBlockOpen) + Buffer.byteLength(eventsBlockClose);

    const includedEvents = [];
    for (let i = events.length - 1; i >= 0; i--) {
      const eventStr = events[i] + '\n';
      const eventBytes = Buffer.byteLength(eventStr, 'utf8');
      if (eventsBytes + eventBytes < remainingBytes) {
        eventsBytes += eventBytes;
        includedEvents.push(eventStr);
      } else {
        break;
      }
    }
    includedEvents.reverse(); // restore chronological order

    trimmedEventsMarkdown = eventsBlockOpen + includedEvents.join('') + eventsBlockClose;
  } else if (remainingBytes <= 0) {
    trimmedEventsMarkdown = `*(Event history omitted due to size limit)*\n`;
  } else {
    trimmedEventsMarkdown = `*(No events recorded)*\n`;
  }

  return baseMarkdown + trimmedEventsMarkdown;
}

// ── IPC handlers ──────────────────────────────────────────────────────────────
export function registerBugReportHandlers() {

  // Save report to a file chosen by the user via a native save dialog.
  handleSafe('export-bug-report', async (event, payload) => {
    const markdownContent = generateMarkdown(payload);

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
    const markdownContent = generateMarkdown(payload);
    return { markdown: markdownContent };
  });
}
