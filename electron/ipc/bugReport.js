import electronPkg from 'electron';
const { dialog, app } = electronPkg;
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { handleSafe, snapshotActiveNodeTasks } from './ipcUtils.js';
import { getAISettings, resolveServiceAccountPath } from './settings.js';
import { getSellMonitorPlatforms, getJobLoginPlatforms } from './stealthBrowser.js';
import { getStatusCacheSync } from './accounts.js';
import { getRecentLogs } from '../logger.js';
import { getGeminiTelemetry } from './gemini.js';
import { getJobsTelemetry } from './jobs.js';
import { getMarketplaceTelemetry } from './marketplace.js';
import { getBudgetSnapshot } from './scrapeBudget.js';
import { getRateLimiterSnapshot } from './rateLimiter.js';
import { getTokenBudgetSnapshot, TOKEN_HARD_CAP } from './tokenBudget.js';
import { shortId } from './bugReport/helpers.js';
import { buildJobsConfigSnapshot, buildJobsPipelineSnapshot } from './bugReport/jobsSnapshot.js';
import { buildMarketplacePipelineSnapshot } from './bugReport/marketplaceSnapshot.js';

// Captured at module load: the moment this code first ran in the main process.
// Used to detect when a user edits a source file but forgets to restart
// Electron — the renderer hot-reloads via Vite but the main-process modules
// keep running the old code, producing the maddening "I changed it, why isn't
// it doing the new thing?" failure mode.
const PROCESS_START_MS = Date.now();

// Long marketplace comp URLs (eBay's run 500-600 chars of tracking params) dominate
// the JSON dump and add zero diagnostic value — the item path is the only useful
// part. As a JSON.stringify replacer, truncate any oversized http(s) URL to
// origin+path and drop the query/hash. General (not per-site): keys on URL shape
// and length, so it trims any bloated URL string anywhere in the state.
const truncateLongUrls = (_key, value) => {
  if (typeof value === 'string' && value.length > 120 && /^https?:\/\//i.test(value)) {
    try {
      const u = new URL(value);
      const dropped = value.length - (u.origin.length + u.pathname.length);
      return dropped > 0 ? `${u.origin}${u.pathname} …(+${dropped} chars of query/params trimmed)` : value;
    } catch {
      return value.slice(0, 120) + ` …(+${value.length - 120} chars trimmed)`;
    }
  }
  return value;
};

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
    // Scan `here`, one level up, and known subdirectories.
    // `browser/` (manualScraper, authWindows, etc.) and `bugReport/` (snapshot builders)
    // must be included or changes to those files won't trigger the stale-build warning.
    const dirs = [here, path.join(here, '..'), path.join(here, 'browser'), path.join(here, 'bugReport')];
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
export function generateMarkdown(payload, reportWindowId = null) {
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
      // jobgroup (category / salary bucket) — show kind, label, count, and
      // expanded state so "why is this empty?" or "why won't it collapse?"
      // reports are diagnosable at a glance.
      if (d.kind && (d.kind === 'category' || d.kind === 'bucket')) {
        previewParts.push(`${d.kind}: ${d.label || '?'}`);
        if (typeof d.count === 'number') previewParts.push(`count: ${d.count}`);
        previewParts.push(`expanded: ${d.expanded ? 'true' : 'false'}`);
        if (Array.isArray(d.childIds)) previewParts.push(`children: ${d.childIds.length}`);
      }
      // Transient source-progress cards (job + marketplace). Surface the source
      // and its persisted progress status, and FLAG one that should have
      // auto-dismissed but is still here — a clean 'done' or a 'skipped' card
      // is supposed to disappear, so seeing it persisted is the "stuck card"
      // bug at a glance (otherwise it's buried in the raw node JSON).
      if (d.sourceId && d.persistedProgress) {
        const p = d.persistedProgress;
        // Google Jobs (isManualPaste source) intentionally stays visible at done+0+no-warning
        // while the hub is paused waiting for the user to paste — not a lingering bug.
        const isPasteWaiting = d.sourceId === 'google' && p.status === 'done' && !p.warning && !(p.count > 0);
        const lingering = !isPasteWaiting && (p.status === 'skipped' || (p.status === 'done' && !p.warning));
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
  // In-memory session cache (populated by verifyAllPlatforms on startup and
  // by writeStatusCache after each login flow). Truth source for the "Log in"
  // vs "Logged in · refresh" pill in Settings → Marketplace Monitors.
  let marketplaceSessionsMarkdown = '';
  if (hasSellNodes) try {
    const platforms = getSellMonitorPlatforms() || [];
    const cache = getStatusCacheSync();

    const rows = platforms.map(p => {
      const entry = cache[p.id];
      const traceStatus = entry?.lastTrace?.status;
      const staleMismatch = entry?.connected && traceStatus != null && traceStatus >= 400;
      const mustContain = p.connectedFinalUrlMustContain;
      const traceFinalUrl = (entry?.lastTrace?.finalUrl || '').toLowerCase();
      const redirectMismatch = !staleMismatch && entry?.connected && mustContain && !traceFinalUrl.includes(mustContain.toLowerCase());
      const connected = entry?.connected
        ? (staleMismatch ? `⚠️ true (last verify ${traceStatus} — URL may have changed)`
          : redirectMismatch ? `⚠️ true (redirected to ${entry.lastTrace.finalUrl} — expected path containing "${mustContain}")`
            : '✅ true')
        : entry ? '❌ false' : '— (no entry)';
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
  if (hasJobNodes) try {
    const platforms = getJobLoginPlatforms() || [];
    const cache = getStatusCacheSync();

    const rows = platforms.map(p => {
      const entry = cache[p.id];
      const traceStatus = entry?.lastTrace?.status;
      const staleMismatch = entry?.connected && traceStatus != null && traceStatus >= 400;
      const mustContain = p.connectedFinalUrlMustContain;
      const traceFinalUrl = (entry?.lastTrace?.finalUrl || '').toLowerCase();
      const redirectMismatch = !staleMismatch && entry?.connected && mustContain && !traceFinalUrl.includes(mustContain.toLowerCase());
      const connected = entry?.connected
        ? (staleMismatch ? `⚠️ true (last verify ${traceStatus} — URL may have changed)`
          : redirectMismatch ? `⚠️ true (redirected to ${entry.lastTrace.finalUrl} — expected path containing "${mustContain}")`
            : '✅ true')
        : entry ? '❌ false' : '— (no entry)';
      const lastConfirmed = entry?.ts
        ? `${new Date(entry.ts).toISOString()} (${Math.round((Date.now() - entry.ts) / 1000)}s ago)`
        : '—';
      const reason = entry?.lastReason ? entry.lastReason.replace(/\|/g, '\\|') : '—';
      return `| \`${p.id}\` | ${p.name} | ${connected} | ${lastConfirmed} | ${reason} |`;
    }).join('\n');

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
  // Learned token budgets — observed output (visible+thinking) tokens per task,
  // which drive the self-calibrating max_tokens cap (effectiveCap). A p95 near
  // the 24576 hard cap means a task is truncating and the cap has grown to match.
  const tokenBudgets = (() => { try { return getTokenBudgetSnapshot(); } catch { return {}; } })();
  const tokenBudgetLines = Object.entries(tokenBudgets)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([task, s]) => {
      // Mirrors tokenBudget.js HEADROOM=1.2: truncation floor = truncatedAt × 1.2.
      // This is the minimum next cap (effectiveCap also folds in seed + learned p95,
      // so the real next cap is ≥ this floor). Showing it makes "will self-heal?"
      // answerable without manual arithmetic.
      const nextCapFloor = s.truncatedAt > 0 ? Math.round(s.truncatedAt * 1.2) : 0;
      // formulaSeedAtTruncation distinguishes "formula is wrong" (seed << truncatedAt,
      // formula needs raising) from "self-calibration lag" (seed ≈ truncatedAt, formula
      // was fine but the observed p95 hadn't yet driven effectiveCap past it).
      const seedNote = (s.truncatedAt > 0 && s.formulaSeedAtTruncation != null)
        ? `formula seed: ${s.formulaSeedAtTruncation}` : '';
      // If the truncation happened AT the hard cap, the self-calibration is permanently
      // stuck — nextCapFloor > HARD_CAP can never be reached and "next cap ≥X" is false.
      const stuckAtHardCap = s.truncatedAt >= TOKEN_HARD_CAP;
      const healNote = stuckAtHardCap
        ? `⛔ AT hard cap (${TOKEN_HARD_CAP}) — self-calibration cannot self-heal; formula or hard cap must be raised`
        : `next cap ≥${nextCapFloor} — until self-healed this task fell back to a weaker model`;
      const detail = seedNote ? `${seedNote}, ${healNote}` : healNote;
      return `- \`${task}\`: p95 ${s.p95} / max ${s.max} tok over ${s.samples} call(s)` +
        (s.truncatedAt > 0
          ? ` · ⚠️ truncated at cap ${s.truncatedAt} (${detail})`
          : '');
    });
  const tokenBudgetMarkdown = tokenBudgetLines.length
    ? `
### Learned Token Budgets
> Observed output (visible + thinking) tokens per task — drives the self-calibrating
> max_tokens cap. A p95 near the ${TOKEN_HARD_CAP} hard cap means that task is truncating. A
> ⚠️ truncated marker means a call hit its cap and silently fell back to a weaker
> model; the cap has since been raised past that point so it shouldn't recur.
> ⛔ AT hard cap means self-calibration is permanently stuck and the formula must be changed.
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
    return `
## Job Search API Configuration
- USAJobs API key set: ${jobsConfig.hasUsajobsKey ? '✅' : '❌'}
- USAJobs Email set: ${jobsConfig.hasUsajobsEmail ? '✅' : '❌'}
- USAJobs key prefix: \`${jobsConfig.usajobsKeyPrefix}\`
`;
  })() : '';

  // The node ids in THIS report's canvas — lets the pipeline snapshots flag a
  // funnel whose originating node isn't here (the main-process telemetry is
  // shared across all open windows/canvases, so it may be another canvas's run).
  const currentNodeIds = new Set((nodes || []).map(n => n?.id).filter(Boolean));

  let jobsPipelineMarkdown = '';
  try { jobsPipelineMarkdown = buildJobsPipelineSnapshot(currentNodeIds, reportWindowId); }
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

  const STATE_BUDGET_BYTES = 1024 * 1024; // 1MB budget for the JSON state block
  // truncateLongUrls strips the tracking-param bloat from marketplace comp URLs
  // (and any other oversized URL) — the item path is kept, the rest is dropped.
  let appStateJson = JSON.stringify(appState, truncateLongUrls, 2);
  let stateWasTrimmed = false;

  if (Buffer.byteLength(appStateJson, 'utf8') > STATE_BUDGET_BYTES) {
    // If the full state is too large, it's almost always due to thousands of drawing points.
    // Omit the drawings but keep the rest of the metadata.
    const { drawings: _drawings, ...trimmedAppState } = appState;
    appStateJson = JSON.stringify(trimmedAppState, truncateLongUrls, 2);
    stateWasTrimmed = true;
  }

  let baseMarkdown = `At the end of your debug, assess whether new bug reporting filter codes need to be implemented. This occurs when even if the user used another existing code or a combination of existing codes, it would not have been enough reporting data to debug this issue smoothly.

# Bug Report

## Issue Description
${description}
${payload.filterCode ? `\n**Filter code applied:** \`${payload.filterCode}\`${payload.filterStats ? ` — event log trimmed to ${payload.filterStats.eventsShown} of ${payload.filterStats.eventsTotal} line(s) (matched categories + nearby context)${payload.filterStats.omittedSections?.length ? `; sections omitted: ${payload.filterStats.omittedSections.join(', ')}` : ''}.` : '.'}\n*This is a filtered view — events outside the matched categories were dropped. Ask the user to re-export with code \`FULL\` if the timeline looks incomplete.*` : ''}

## Application State Summary
- Nodes: ${sectionOmitted('nodes') ? '*(omitted by filter code)*' : (nodes ? nodes.length : 0)}
- Edges: ${sectionOmitted('edges') ? '*(omitted by filter code)*' : (edges ? edges.length : 0)}
- Drawings: ${sectionOmitted('drawings') ? '*(omitted by filter code)*' : `${drawings ? drawings.length : 0} ${stateWasTrimmed ? '*(Omitted from JSON below due to size)*' : ''}`}
- Active Tool: ${frontEndState?.activeTool || 'None'}
- OS: ${systemInfo.platform} ${systemInfo.arch}
${viewportLine}
${buildFreshnessMarkdown}${persistedWorkspaceMarkdown}${activeTasksMarkdown}${aiConfigMarkdown}${jobsConfigMarkdown}${jobsPipelineMarkdown}${issueReporterDraftMarkdown}${marketplacePipelineMarkdown}${marketplaceSessionsMarkdown}${jobSessionsMarkdown}${scraperAdaptationMarkdown}${mainProcessLogsMarkdown}${activeEditableMarkdown}${lastSaveErrorMarkdown}${nodeDiagMarkdown}${mediaMarkdown}${imageMarkdown}
<details>
<summary><b>Click here to expand the full JSON Application State</b></summary>

\`\`\`json
${appStateJson}
\`\`\`

</details>

## Event History
`;

  // Static safety bound (not adaptive): keeps the assembled bug-report payload
  // from ballooning past what's reasonable to ship/store.
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
    const markdownContent = generateMarkdown(payload, event.sender?.id ?? null);

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
    const markdownContent = generateMarkdown(payload, event.sender?.id ?? null);
    return { markdown: markdownContent };
  });
}
