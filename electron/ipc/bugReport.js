import electronPkg from 'electron';
const { dialog, app } = electronPkg;
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { handleSafe, snapshotActiveNodeTasks } from './ipcUtils.js';
import { getAISettings, resolveServiceAccountPath, getJobsSettings } from './settings.js';
import { getSellMonitorPlatforms, getJobLoginPlatforms } from './stealthBrowser.js';
import { getRecentLogs } from '../logger.js';
import { getGeminiTelemetry } from './gemini.js';
import { getJobsTelemetry } from './jobs.js';
import { getMarketplaceTelemetry } from './marketplace.js';
import { getBudgetSnapshot } from './scrapeBudget.js';
import { getRateLimiterSnapshot } from './rateLimiter.js';
import { getTokenBudgetSnapshot, TOKEN_HARD_CAP } from './tokenBudget.js';

// Captured at module load: the moment this code first ran in the main process.
// Used to detect when a user edits a source file but forgets to restart
// Electron — the renderer hot-reloads via Vite but the main-process modules
// keep running the old code, producing the maddening "I changed it, why isn't
// it doing the new thing?" failure mode.
const PROCESS_START_MS = Date.now();

// "(Ns ago)" suffix for a timestamp — shared by the pipeline snapshot builders.
const ago = (ts) => {
  if (!ts) return '';
  const s = Math.round((Date.now() - ts) / 1000);
  return Number.isFinite(s) ? ` (${s}s ago)` : '';
};

// Renders the model that actually served an AI stage (recorded per stage via the
// LLM layer's `meta` out-param). Flags a degraded run: a `*-lite` model = the
// call fell through every stronger model (404/quota) to the weakest fallback —
// so e.g. a "strong match" price is really flash-lite's verdict, not a top
// model's. Empty when no model was recorded (older telemetry).
const modelTag = (model) => {
  if (!model) return '';
  const weak = /lite/.test(model);
  return ` · model: \`${model}\`${weak ? ' ⚠️ weak fallback' : ''}`;
};

// Verdict for what the top-25/15 comp cap actually dropped — does it skew the
// price? Two facts matter. (1) Compare the TYPICAL dropped comp (its median) to
// the typical kept one, not a lone outlier — the old dropped.max ≥ kept.median
// test fired on essentially every run. (2) Crucially, the cap selects by
// title-match RELEVANCE, not price. So a kept/dropped PRICE gap is only a skew if
// the cap dropped comps as on-spec as the ones it kept; when the dropped comps
// are clearly less relevant (the cap shedding off-spec/junk listings, which tend
// to be cheap), a price gap is the EXPECTED result of good ranking, not a bias.
// Without that relevance check a well-ranked run that correctly drops cheap junk
// looks "biased HIGH" — a false alarm. keptScore/droppedScore are the median
// title-match scores (see marketplace.js medianScore).
//   • dropped median below the kept range      → cheap noise, cap working (no flag)
//   • dropped median ≈ kept median (≤15%)       → representative sample, NOT skewed
//   • price gap >15% but dropped less relevant  → cap shed off-spec comps, ranking working (no flag)
//   • price gap >15% at comparable relevance    → cap shed equally on-spec comps → price biased
const dropBandVerdict = (kept, dropped, keptScore, droppedScore) => {
  if (!kept || !dropped) return '';
  if (dropped.median < kept.min) {
    return ' Dropped sit below the kept band (low-relevance noise — cap working as intended).';
  }
  const rel = kept.median > 0 ? (dropped.median - kept.median) / kept.median : 0;
  if (Math.abs(rel) <= 0.15) {
    return ` ✅ dropped median $${dropped.median} ≈ kept median $${kept.median} — the cap dropped a representative sample, so the price is not skewed by it (the 25/15 cap is a by-design cost bound, not lost signal).`;
  }
  const pct = Math.round(Math.abs(rel) * 100);
  const dir = rel > 0 ? 'ABOVE' : 'BELOW';
  const bias = rel > 0 ? 'LOW' : 'HIGH';  // dropped pricier ⇒ kept skews low; dropped cheaper ⇒ kept skews high
  const haveScores = keptScore != null && droppedScore != null && keptScore > 0;
  const scoreNote = haveScores ? ` (median match score ${droppedScore} vs kept ${keptScore})` : '';
  // Dropped comps clearly less relevant than kept → the cap correctly kept the
  // closest matches; the price gap is the ranking working, not a bias.
  if (haveScores && droppedScore < keptScore * 0.85) {
    return ` dropped median $${dropped.median} is ${pct}% ${dir} kept median $${kept.median}, but the dropped comps are less relevant${scoreNote} — the cap kept the closest-matching listings and shed lower-relevance ${rel > 0 ? 'pricier' : 'cheaper'} ones, so the gap is the ranking working as intended, not a price bias.`;
  }
  return ` ⚠️ dropped median $${dropped.median} is ${pct}% ${dir} kept median $${kept.median} at comparable relevance${scoreNote} — the cap shed comps as on-spec as those it kept, so the price may be biased ${bias} (raise the cap or improve the comp ranking).`;
};

// Long marketplace comp URLs (eBay's run 500-600 chars of tracking params) dominate
// the JSON dump and add zero diagnostic value — the item path is the only useful
// part. As a JSON.stringify replacer, truncate any oversized http(s) URL to
// origin+path and drop the query/hash. General (not per-site): keys on URL shape
// and length, so it trims any bloated URL string anywhere in the state.
const truncateLongUrls = (key, value) => {
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

// Pipeline telemetry (jobs + marketplace) is a main-process singleton SHARED by
// every open canvas WINDOW, so the "last run" it holds may belong to a different
// window than the one this report was generated from. The originating window id
// (webContents id) is the authoritative scope: if it differs from the window
// that requested the report, the run is another canvas's and is OMITTED — the
// report only reflects the canvas it was triggered from.
//
// Node presence alone can't decide this: a node missing from the current canvas
// could be another window's node OR this window's hub that the user DELETED after
// the run (the telemetry deliberately outlives the hub — that's its whole point).
// So node presence only refines the wording for same-window runs; windowId
// decides inclusion. Unknown ids (older telemetry / no sender) → treat as local.
// Produce a short but meaningful identifier for any node ID.
// UUID-style IDs (e.g. "3539d90c-e09d-…") are unique in their first segment,
// so we show the first 8 chars. All other IDs (e.g. "job-1779484861758-job-0",
// "job-1779484861758-cat-2-buc-1") embed a shared timestamp prefix that makes
// the first 8 chars identical across every job node — we show the last 8 chars
// instead so the unique suffix ("-job-0", "-buc-1") is visible.
const shortId = (id) => {
  const s = String(id);
  if (s.length <= 8) return s;
  if (/^[0-9a-f]{8}-/.test(s)) return s.slice(0, 8); // UUID: first segment is unique
  return `…${s.slice(-8)}`;                           // timestamp-prefixed: show suffix
};

const pipelineScope = (nodeId, windowId, currentNodeIds, reportWindowId) => {
  if (windowId != null && reportWindowId != null && windowId !== reportWindowId) {
    return {
      foreign: true,
      note: "> (No run recorded for this canvas this session — these pipeline tallies are a main-process singleton shared by every open window, and the most recent run was in a DIFFERENT window/canvas, so it is omitted here rather than misattributed to this one.)\n",
    };
  }
  if (!nodeId) return { foreign: false, note: '' };
  const short = shortId(nodeId);
  const deleted = currentNodeIds && currentNodeIds.size > 0 && !currentNodeIds.has(nodeId);
  return {
    foreign: false,
    note: `> Source node: \`${short}\`${deleted ? ' (hub since deleted from this canvas — telemetry retained so the run still reports)' : ''}.\n`,
  };
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
function buildJobsPipelineSnapshot(currentNodeIds, reportWindowId) {
  let t;
  try { t = getJobsTelemetry(); } catch { return ''; }
  const hasResolves = t && t.resolves && Object.keys(t.resolves).length > 0;
  const hasPastes = Array.isArray(t?.pastedPastes) ? t.pastedPastes.length > 0 : !!t?.pastedParse; // back-compat with old single-object field
  if (!t || (!t.search && !hasResolves && !t.scoring && !t.bucketing && !hasPastes)) return '';

  const scope = pipelineScope(t.nodeId, t.windowId, currentNodeIds, reportWindowId);
  if (scope.foreign) return `\n## Job Search Pipeline\n${scope.note}`;

  // Read session cache once — used to annotate pagination warnings with login status.
  let sessionCache = {};
  try {
    const cachePath = path.join(app.getPath('userData'), 'session-status-cache.json');
    sessionCache = JSON.parse(fs.readFileSync(cachePath, 'utf8')) || {};
  } catch { /* cache absent is fine — treat all platforms as unconfirmed */ }

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
    // Per-source raw counts — the "was this source silently not gathered?" line.
    // A 0 WITH a warning is a real miss to chase; a clean 0 is genuinely-empty or
    // off-category (e.g. a cinematographer on USAJobs/Dice). Without this you only
    // saw the aggregate raw count and couldn't tell which sources contributed.
    if (s.bySource && Object.keys(s.bySource).length > 0) {
      const entries = Object.entries(s.bySource);
      const got = entries.filter(([, v]) => v.count > 0).map(([k, v]) => `${k}=${v.count}`);
      lines.push(`- Per source (raw gathered): ${got.length ? got.join(', ') : '(none)'}`);
      // Date-bounded deep pagination: how deep each paginating source walked and
      // why it stopped. `date-cutoff`/`empty-page`/`duplicate-page` = the source
      // ran out of in-window jobs (the healthy, intended stop). `blocked` = an
      // anti-bot wall cut it short (the page count is where to start walking the
      // ceiling DOWN). `ceiling` = hit JOB_MAX_PAGES with jobs still coming (the
      // window may hold more — consider raising the cap). One-shot/API sources
      // have no walk and don't appear here.
      const walked = entries.filter(([, v]) => v.pagesWalked > 0);
      for (const [k, v] of walked) {
        let flag = '';
        if (v.stopReason === 'blocked') {
          flag = ' ⚠️';
        } else if (v.stopReason === 'ceiling') {
          // A page-ceiling where most rows deduped away means the page param
          // re-served the same page (clamping) — NOT genuine depth, so "may be
          // more" would mislead. The raw↔unique gap is the tell.
          const raw = v.count || 0, uniq = v.unique;
          const notLoggedIn = !sessionCache[k]?.connected;
          const isReserved = uniq != null && raw > 0 && uniq <= raw / 2;
          const loginNote = notLoggedIn ? ` Not logged in at search time — platform may ignore pagination without a session.` : '';
          // Re-served pages while cache says connected is a red flag: the most
          // common cause of silent re-serving is an invalid/expired session that
          // the verifier mistakenly accepted (false positive). Surface it so the
          // user knows to re-verify their login rather than chase a code bug.
          const falsePosNote = (!notLoggedIn && isReserved)
            ? ` Cache says logged in — but re-served pages are the signature of a blocked (unauthenticated) session. The verify URL may be producing a false positive; try logging out and back in via Settings → Job Platform Logins.`
            : '';
          if (isReserved) {
            flag = ` ⚠️ (hit page cap, but ${raw} gathered → only ${uniq} unique: re-served/clamped pages, likely NOT more — the page-param is probably repeating.${loginNote}${falsePosNote})`;
          } else {
            flag = ` ⚠️ (hit page cap — may be more.${loginNote})`;
          }
        }
        lines.push(`  - \`${k}\`: walked ${v.pagesWalked} page${v.pagesWalked === 1 ? '' : 's'}${v.stopReason ? ` → stopped: ${v.stopReason}` : ''}${flag}`);
      }
      // API/feed sources don't paginate — they grab matches in document order and
      // keep the top JOB_RESULT_CAP with no quality signal. When a source MATCHED
      // more than it surfaced, that overflow was never gathered: the API analogue
      // of the browser `ceiling` stop, and the one "silently not gathered" path the
      // per-source counts above couldn't reveal (a capped source looks identical to
      // an exhausted one). gathered is set only for API sources; > count = truncated.
      const apiCapped = entries.filter(([, v]) => v.gathered != null && v.gathered > v.count);
      for (const [k, v] of apiCapped) {
        lines.push(`  - \`${k}\`: surfaced ${v.count} of ${v.gathered} in-window matches ⚠️ (per-source cap — ${v.gathered - v.count} more matched but not gathered; raise JOB_RESULT_CAP to widen)`);
      }
      const zeroPaste = entries.filter(([, v]) => v.count === 0 && v.warning?.code === 'paste-needed').map(([k]) => k);
      const zeroWarn = entries.filter(([, v]) => v.count === 0 && v.warning && v.warning.code !== 'paste-needed').map(([k, v]) => `${k} (${v.warning.code})`);
      const zeroClean = entries.filter(([, v]) => v.count === 0 && !v.warning).map(([k]) => k);
      if (zeroPaste.length) {
        lines.push(`  - ⏳ paste-needed (hub paused waiting for manual copy/paste — expected, not a scrape failure): ${zeroPaste.join(', ')}`);
      }
      if (zeroWarn.length) {
        lines.push(`  - ⚠️ 0 results + flagged (real miss to investigate): ${zeroWarn.join(', ')}`);
      }
      if (zeroClean.length) {
        lines.push(`  - 0 results, no warning (genuinely empty / off-category): ${zeroClean.join(', ')}`);
      }
    }
    // Per-source progress-event trail — the sequence of status/warning events the
    // backend sent for each source, with timing relative to search start. This is
    // what diagnoses "a source was blocked but its resolve card vanished": the
    // renderer Event History shows WHEN a card node was removed, but only this
    // shows whether the source ever emitted a clean 'done' (which auto-dismisses
    // the card) or sat 'error'-without-warning for a long stretch (a card that
    // looks idle). Shown only for sources that ended non-clean or flip-flopped
    // between clean and failed — a plain searching→done source needs no trail.
    if (t.sourceEvents && Object.keys(t.sourceEvents).length > 0) {
      const interesting = Object.entries(t.sourceEvents).filter(([, evs]) => {
        const statuses = new Set((evs || []).map(e => e.status));
        const lastStatus = evs?.[evs.length - 1]?.status;
        return lastStatus === 'error' || lastStatus === 'skipped' ||
          (statuses.has('done') && (statuses.has('error') || statuses.has('skipped')));
      });
      if (interesting.length > 0) {
        lines.push('- Source progress-event trail (status@+s from search start; ⚠ = warning carried):');
        for (const [sid, evs] of interesting) {
          const trail = (evs || []).map(e =>
            `${e.status}${e.code ? `⚠${e.code}` : ''}@+${Math.round((e.t || 0) / 1000)}s`).join(' → ');
          lines.push(`  - \`${sid}\`: ${trail}`);
        }
      }
    }
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
      // If the renderer reported the actual merge outcome, show net pendingJobs
      // change. Without it, "new: N" from the IPC side overstates the contribution
      // when the resolver re-opened a page the initial scrape already captured
      // (same-source jobs are replaced, so the net change may be 0 even if kept=N).
      const m = r.merge;
      let mergeNote;
      if (m != null) {
        const netChange = m.pendingAfter - m.pendingBefore;
        const netStr = netChange >= 0 ? `+${netChange}` : `${netChange}`;
        mergeNote = ` → replaced ${m.replacedExisting} existing → **net pendingJobs ${netStr} (${m.pendingBefore}→${m.pendingAfter})**`;
      } else {
        mergeNote = ` → **new (to history): ${r.kept}**`;
      }
      lines.push(
        `- \`${sourceId}\`${ago(r.ts)}: inline-extracted ${r.extracted} → age-dropped ${r.ageDropped} → ` +
        `already-seen/history ${r.historyDropped}${mergeNote}`,
      );
      if (r.extracted > 0 && r.kept === 0) {
        lines.push('  - _(every extracted job was already shown on a prior run — correctly suppressed, not re-analyzed)_');
      }
      // Net change = 0 means the resolve refreshed existing same-source jobs but
      // added nothing to the scoring queue. Explains "new: N" vs "scored: M" gaps.
      if (m != null && m.pendingAfter === m.pendingBefore && m.replacedExisting > 0) {
        lines.push(`  - _(replaced ${m.replacedExisting} existing ${sourceId} jobs with fresh data; net pendingJobs unchanged — these count toward scoring already)_`);
      }
      // The "why" behind a 0-extract — turns "Solve did nothing" into a named
      // cause: how the window closed, what the inline extractor returned, and
      // whether a wall was up. Without it a 0 could be a stale extractor, a
      // thrown extractor, a genuinely empty page, or a window closed too early.
      const d = r.diag;
      if (d) {
        const bits = [`closed: ${d.closeReason}`, `extractor: ${d.extractOutcome}`];
        if (d.textLen != null) bits.push(`page textLen ${d.textLen}`);
        if (d.sawChallenge) bits.push('challenge seen');
        if (d.sawConsent) bits.push('consent wall seen');
        if (d.finalHost) bits.push(`host ${d.finalHost}`);
        lines.push(`  - resolve detail: ${bits.join(' · ')}`);
        // Stale-selector / changed-layout fingerprint: the extractor matched 0
        // on a page that had real text and no challenge/consent that would have
        // hidden the results — i.e. the page rendered but the selectors missed it.
        if (r.extracted === 0 && d.extractOutcome === 'matched 0' && !d.sawChallenge && !d.sawConsent && (d.textLen || 0) > 0) {
          lines.push('  - ⚠️ extractor matched 0 on a content-bearing page with no challenge/consent up — the source\'s layout likely changed (stale selectors), NOT a genuinely empty result. This is the "I solved it and saw jobs, but it failed" case.');
        }
      }
    }
  }

  // Manual paste → parse (Google fallback). A failed/0 submit is the "I pasted
  // and clicked Submit but it failed" case — usually the parse output exceeded
  // its token cap and truncated. Surfaced here so it's not inferable only from
  // the job-scoring token-budget truncation marker.
  // Back-compat: older builds wrote a single pastedParse object; new builds write
  // a pastedPastes array so multiple mid-run + post-reblock pastes are all visible.
  const allPastes = Array.isArray(t.pastedPastes) && t.pastedPastes.length > 0
    ? t.pastedPastes
    : (t.pastedParse ? [t.pastedParse] : []);
  if (allPastes.length > 0) {
    lines.push('\n### Manual paste (Google fallback)');
    for (const p of allPastes) {
      lines.push(
        `- \`${p.sourceId}\`${ago(p.ts)}: pasted ${p.chars} chars${p.chunks > 1 ? ` in ${p.chunks} chunks` : ''} → **parsed ${p.parsed} job(s)**` +
        (p.error ? ` ⚠️ ${p.error}` : ' → merged into pendingJobs for scoring'),
      );
      if (p.error && p.parsed === 0) {
        lines.push('  - _(this submit added NO jobs — not silently dropped: the card stays so the user can retry with a smaller paste)_');
      }
    }
    if (allPastes.length > 1) {
      lines.push(`  - _(${allPastes.length} paste submissions this run — multiple pastes indicate the hub re-blocked and required a second resolve)_`);
    }
  }

  if (t.scoring) {
    const s = t.scoring;
    const clean = s.placeholders === 0 && s.unscored === 0;
    const selected = s.selectedForScoring ?? s.input; // back-compat with pre-cap telemetry
    lines.push(`\n### Scoring${ago(s.ts)}`);
    if (s.cappedForBudget > 0) {
      // The budget cap is an intentional drop, surfaced so it's not silent:
      // a wider gather means the kept jobs are the best slice across sources,
      // not all of them. Widening the scrape improves WHICH jobs make this cut.
      lines.push(`- Gathered: ${s.input} → pre-ranked to top **${selected}** across sources for scoring (${s.cappedForBudget} lower-priority overflow not scored — by-design budget cap to bound LLM cost, not a failure).`);
      lines.push(`- Scored: ${s.scored}/${selected} ${clean ? '✅ all selected jobs genuinely analyzed' : ''}`);
    } else {
      lines.push(`- Input: ${s.input} → scored: ${s.scored} ${clean ? '✅ all genuinely analyzed' : ''}`);
    }
    // Reconcile the scorer's input against what was actually gathered THIS session
    // (search + paste + captcha-resolves). When input exceeds that, the surplus was
    // carried over from a PRIOR run — job cards persisted on the canvas, re-scored
    // alongside this session's gather. They weren't gathered this session, so their
    // scrape funnel isn't in this report. Surfaced so a "99 scored but only 65
    // gathered here" gap reads as carry-over, not jobs appearing from nowhere.
    // Use merge.net (renderer-side) when available — it accounts for same-source
    // replacement (resolver re-opens a page the initial scrape already captured,
    // so kept=11 IPC-side but net pendingJobs change=0). Without it, sessionGathered
    // overstates by replacedExisting, making scoring input look like carry-over.
    const pastedTotal = allPastes.reduce((sum, p) => sum + (p.parsed || 0), 0);
    const sessionGathered = (t.search?.kept || 0) + pastedTotal +
      Object.values(t.resolves || {}).reduce((sum, r) => {
        const m = r?.merge;
        return sum + (m != null ? (m.pendingAfter - m.pendingBefore) : (r?.kept || 0));
      }, 0);
    const carried = s.input - sessionGathered;
    if (carried > 0) {
      lines.push(`  - _(${sessionGathered} gathered this session; the other **${carried}** were carried over from a prior run — already on the canvas, re-scored here. Not gathered this session, so their scrape funnel isn't above — and not silently added.)_`);
    }
    lines.push(`- Batches: ${s.batches} (${s.failedBatches} failed)${modelTag(s.models?.length ? s.models.join(', ') : null)}`);
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
    if (b.error) {
      // The bucket call threw (e.g. Claude's "streaming required" rejection at a
      // high max_tokens cap, an LLM truncation, or fallback-chain exhaustion).
      // The renderer caught it and spawned a FLAT job list. Surface the error and
      // its consequence so this is never mistaken for a clean run OR for the
      // "never ran" null slot below — both of which hide that categorization died.
      lines.push(`- ❌ **Bucketing FAILED** on ${b.input} scored job(s)${modelTag(b.model)} — jobs were spawned as a FLAT, uncategorized list (none dropped, but the category/salary tree is lost).`);
      lines.push(`  - Error: ${b.error}`);
    } else if (b.placed != null) {
      // Placement check: did the bucketer assign every scored job to a bucket?
      const clean = b.missing === 0 && b.duplicated === 0;
      lines.push(`- Input: ${b.input} → **${b.placed} placed** across ${b.categories} categories${clean ? ' ✅ all jobs placed' : ''}${modelTag(b.model)}`);
      if (b.missing > 0) {
        const idxNote = Array.isArray(b.missingIndices) && b.missingIndices.length > 0
          ? ` Missing indices (0-based): [${b.missingIndices.join(', ')}]`
          : '';
        lines.push(`  - ⚠️ **${b.missing} scored job(s) NOT placed by the bucketer** (it broke the "every job in exactly one bucket" rule — common on the weak fallback models quota forces). The renderer's missing-sweep rescues them into an Uncategorized branch — shown, not dropped, but uncategorized.${idxNote}`);
      }
      if (b.duplicated > 0) {
        lines.push(`  - ⚠️ ${b.duplicated} job(s) placed in more than one bucket by the bucketer (deduped on spawn).`);
      }
    } else {
      lines.push(`- Input: ${b.input} → categories: ${b.categories}${modelTag(b.model)}`);
    }
    if (!b.error && b.categories === 0 && b.input > 0) {
      lines.push('- ⚠️ Bucketing returned 0 categories — the renderer will have fallen back to a flat spawn (jobs still shown, but the category/salary tree is lost).');
    }
  } else {
    lines.push('\n### Bucketing\n- (no bucketing recorded this session)');
  }

  return `
## Job Search Pipeline
${scope.note}> Last run's funnel, captured in the main process so it survives hub deletion
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
function buildMarketplacePipelineSnapshot(currentNodeIds, reportWindowId) {
  let t;
  try { t = getMarketplaceTelemetry(); } catch { return ''; }
  const hasResolves = t && t.resolves && Object.keys(t.resolves).length > 0;
  if (!t || (!t.analyze && !t.scrape && !hasResolves && !t.synthesis && !t.fit)) return '';

  const scope = pipelineScope(t.nodeId, t.windowId, currentNodeIds, reportWindowId);
  if (scope.foreign) return `\n## Marketplace Pipeline\n${scope.note}`;

  const lines = [];

  if (t.analyze) {
    const a = t.analyze;
    lines.push(`### Product analysis${ago(a.ts)}`);
    lines.push(`- ${a.photos} photo(s) → "${a.title}"${modelTag(a.model)}`);
  }

  if (t.scrape) {
    const s = t.scrape;
    const errored = s.errored ?? 0;
    lines.push(`\n### Comp scrape${ago(s.ts)}`);
    lines.push(
      `- ${s.sources} sources → **${s.sold} sold + ${s.active} active** comps · ${s.warnings} warning(s)` +
      `${s.blocked > 0 ? `, ${s.blocked} anti-bot block(s)` : ''}` +
      `${errored > 0 ? `, ${errored} scrape error(s)` : ''}`,
    );
    if (s.bySource && Object.keys(s.bySource).length > 0) {
      // Per-source raw counts — pair with the synthesis "unique" line below to
      // spot a single source double-counting (e.g. a healthy-looking total
      // that's mostly one source's duplicates). A ⚠️<code> after a count names
      // WHY that source returned what it did — so a 0 isn't silently ambiguous.
      const sw = s.sourceWarnings || {};
      const atCap = s.bySourceAtCap || {};
      // `(cap)` after a count = the source returned exactly its extraction cap,
      // so the page almost certainly held MORE listings than we gathered. The
      // count is a floor, not the full available total.
      lines.push(`- Per source (raw items): ${Object.entries(s.bySource).map(([id, n]) => `${id}=${n}${atCap[id] ? ' (cap)' : ''}${sw[id] ? ` ⚠️${sw[id].code}` : ''}`).join(', ')}`);
      // Spell out each flagged source's evidence (e.g. "extractor produced 0
      // items (expected ≥ 3)" = stale selectors / empty vs. a tiny-body block).
      for (const [id, w] of Object.entries(sw)) {
        lines.push(`  - \`${id}\` (${w.severity}): ${w.evidence}`);
      }
      const cappedIds = Object.keys(atCap);
      if (cappedIds.length > 0) {
        // Answers "silently not gathered from scrape?": these per-source totals
        // are floors. Not lost downstream (synthesis caps at 25 sold / 15 active
        // and selects fairly across sources), but the gathered set under-counts
        // what each page actually offered.
        lines.push(`  - _(\`(cap)\` = hit the ${cappedIds.map(id => `${id}=${atCap[id]}`).join(', ')} extraction cap — page held more than gathered; these counts are floors. Not lost downstream: synthesis caps at 25 sold / 15 active and selects fairly across sources.)_`);
      }
    }
    if (s.blocked > 0) {
      lines.push('- _(anti-bot-blocked sources contribute 0 comps until solved via the card\'s Solve button — see the resolve stage / Recent Logs)_');
    }
    if (errored > 0) {
      lines.push('- _(scrape error(s) = the scrape threw before completing — e.g. a browser-launch/profile-lock conflict or network failure, NOT an anti-bot wall. A visible window opened mid-scrape can race the headless profile lock. See Recent Logs.)_');
    }
  }

  if (hasResolves) {
    // One line per resolved source (newest first) so a multi-source recovery
    // — e.g. Mercari then eBay — shows every resolve, not just the last.
    const entries = Object.entries(t.resolves).sort((a, b) => (b[1]?.ts || 0) - (a[1]?.ts || 0));
    lines.push('\n### Captcha-resolve / Solve');
    for (const [sourceId, r] of entries) {
      // `via` distinguishes how the items reached the pricing set: 'inline' =
      // pulled directly from the visible captcha-resolve session; 'rescrape' =
      // inline came back empty and a headless rescrape recovered them. Reporting
      // the rescrape count (not the inline 0) is what keeps a successful recovery
      // from looking like a failure.
      const line = r.via === 'rescrape'
        ? `- \`${sourceId}\`${ago(r.ts)}: rescraped ${r.extracted} ${r.category} comp(s) into the pricing set (inline extract failed; recovered via headless rescrape)`
        : `- \`${sourceId}\`${ago(r.ts)}: inline-extracted ${r.extracted} ${r.category} comp(s) merged into the pricing set`;
      lines.push(line + (r.extracted === 0 ? ' ⚠️ recovered 0 — source contributed nothing to pricing' : ''));
    }
  }

  if (t.synthesis) {
    const s = t.synthesis;
    lines.push(`\n### Price synthesis${ago(s.ts)}`);
    if (s.junkRejected > 0) {
      // Non-genuine listings dropped before pricing — reported so the rejection
      // is transparent (and so a spike signals a new junk pattern to filter).
      // Two classes today (see filterJunkComps): accessories FOR the item (cases,
      // chargers, screen protectors — the bulk, esp. from Poshmark) and eBay
      // internal test listings. Keep the description in sync with the filter so
      // the example never contradicts the explanation.
      lines.push(`- 🧹 Rejected ${s.junkRejected} non-genuine listing(s) before pricing${s.junkExample ? ` (e.g. "${s.junkExample}")` : ''} — accessories for the item (cases/chargers/etc.) and eBay internal test listings, not real comps.`);
    }
    if (s.soldFound + s.activeFound === 0) {
      lines.push('- ⚠️ 0 comps available → no price synthesized (all sources empty or blocked).');
    } else {
      const capped = s.soldFound > s.soldUsed || s.activeFound > s.activeUsed;
      lines.push(
        `- Comps fed to the model: ${s.soldUsed}/${s.soldFound} sold + ${s.activeUsed}/${s.activeFound} active` +
        (capped ? ' _(capped at the top 25 sold / 15 active by title-match — by-design, not lost data)_' : ''),
      );
      // Found vs. unique — a gap means an extractor emitted the same listing
      // multiple times, so the "found"/"used" totals overstate the real signal
      // the model saw (duplicates aren't lost data, they're phantom data).
      const soldDup = s.soldUnique != null ? s.soldFound - s.soldUnique : 0;
      const activeDup = s.activeUnique != null ? s.activeFound - s.activeUnique : 0;
      if (soldDup > 0 || activeDup > 0) {
        lines.push(
          `- ⚠️ Duplicate comps: only **${s.soldUnique} unique** of ${s.soldFound} sold` +
          ` and **${s.activeUnique} unique** of ${s.activeFound} active — an extractor is double-counting listings, inflating the set fed to pricing (check Per-source counts above to find which).`,
        );
      } else if (s.soldUnique != null) {
        lines.push(`- All ${s.soldFound} sold / ${s.activeFound} active comps are distinct (no duplicate inflation).`);
      }
      // What the cap actually dropped — the evidence behind "by-design, not lost
      // data." dropBandVerdict compares the dropped slice's median to the kept
      // band to say whether the drop SKEWED the price (and which way) vs. dropped
      // a representative sample (price unaffected) vs. cheap noise (cap working).
      if (capped) {
        const fmt = (st) => st ? `$${st.min}–$${st.max} (median $${st.median})` : '—';
        if (s.soldDroppedStats) {
          lines.push(
            `- Dropped ${s.soldDroppedStats.n} sold ${fmt(s.soldDroppedStats)}; kept ${fmt(s.soldKeptStats)}.` +
            dropBandVerdict(s.soldKeptStats, s.soldDroppedStats, s.soldKeptScore, s.soldDroppedScore),
          );
        }
        if (s.activeDroppedStats) {
          lines.push(
            `- Dropped ${s.activeDroppedStats.n} active ${fmt(s.activeDroppedStats)}; kept ${fmt(s.activeKeptStats)}.` +
            dropBandVerdict(s.activeKeptStats, s.activeDroppedStats, s.activeKeptScore, s.activeDroppedScore),
          );
        }
        // Per-source composition of the sold kept/dropped split — exposes a
        // source monopoly (one source filling the cap while a better one is
        // dropped) that the price-band lines alone can't show. The round-robin
        // selection should keep this balanced; a lopsided split is the tell.
        const bySrc = (m) => m && Object.keys(m).length
          ? Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(', ')
          : '—';
        if (s.soldKeptBySource || s.soldDroppedBySource) {
          lines.push(`- Sold by source — kept: ${bySrc(s.soldKeptBySource)} · dropped: ${bySrc(s.soldDroppedBySource)}`);
        }
        // Wrong-product detector: a kept source whose comps barely match the
        // query (median match score collapsed to ~brand-only, well below the
        // overall kept score) returned off-target results — e.g. Swappa serving
        // Apple Vision Pro for an iPhone XS query. Round-robin selection forces
        // each source's "best" in even when that best is the wrong item, so this
        // junk reaches pricing silently unless named here.
        if (s.soldKeptScoreBySource && s.soldKeptScore > 0) {
          const offenders = Object.entries(s.soldKeptScoreBySource)
            .filter(([src, sc]) => sc != null && sc < s.soldKeptScore * 0.5 && (s.soldKeptBySource?.[src] || 0) >= 2)
            .sort((a, b) => a[1] - b[1])
            .map(([src, sc]) => `${src} (median match ${sc} vs overall ${s.soldKeptScore}, ${s.soldKeptBySource[src]} kept)`);
          if (offenders.length) {
            lines.push(`- ⚠️ Off-target source(s) in the priced set: ${offenders.join('; ')} — these kept comps barely match the query (likely wrong-product results), polluting the pricing input. Their prices skew the kept band above.`);
          }
        }
      }
      lines.push(`- Result: recommended_price=${s.recommendedPrice == null ? '**null** ⚠️ (comps scraped but no price produced)' : '$' + s.recommendedPrice}, match_quality=${s.matchQuality}${modelTag(s.model)}`);
      // The model's own anchor/adjusted/bound split — the LAST place a comp can
      // be dropped (the model weighting it out). The found→fed cap is reported
      // above; this is the fed→actually-weighted gap. classified ≪ fed is normal
      // (the model ignores off-spec listings), but a tiny anchor count on a big
      // fed set is the tell that the price leans on very few real matches.
      if (s.compBreakdown) {
        const cb = s.compBreakdown;
        // Guard a malformed breakdown: the model occasionally fumbles this nested
        // object (leaks the inner counts / tool-call XML instead of nesting them),
        // so cb arrives as a string or with non-numeric counts. claude.js repairs
        // it, but if a malformed one still reaches here, say so — don't render the
        // misleading "0 anchor + 0 adjusted + 0 bound … thin anchor base" that a
        // raw `|| 0` would produce (the model DID classify; the shape was broken).
        const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
        const wellFormed = cb && typeof cb === 'object' && !Array.isArray(cb) &&
          (isNum(cb.anchor_count) || isNum(cb.adjusted_count) || isNum(cb.bound_count));
        if (!wellFormed) {
          lines.push(`- ⚠️ Model weighting unavailable — comp_breakdown came back malformed (${JSON.stringify(cb).slice(0, 80)}). The model's anchor/adjusted/bound split couldn't be read (structured-output shape error); the price itself is unaffected.`);
        } else {
          const anchor = cb.anchor_count || 0, adjusted = cb.adjusted_count || 0, bound = cb.bound_count || 0;
          const classified = anchor + adjusted + bound;
          const fed = (s.soldUsed || 0) + (s.activeUsed || 0);
          lines.push(
            `- Model weighting: ${anchor} anchor + ${adjusted} adjusted + ${bound} bound = ${classified} of ${fed} fed classified` +
            (classified < fed
              ? ` — the model weighted out the other ${fed - classified} as off-spec. The price leans on ${anchor} exact-match anchor listing(s)${anchor <= 2 ? ' ⚠️ (thin anchor base — verify against the kept band above)' : ''}.`
              : '.'),
          );
        }
      }
      // Model's own market summary — its internal tally of what it counted as
      // genuine comps (after its own classification). The fed→model-counted gap
      // is the last invisible drop: we feed N active but the model may count 0
      // if it judged them all as accessories/parts. Flag when active_count=0
      // despite activeUsed>0 so that's visible rather than a mystery.
      if (s.marketSummary) {
        const ms = s.marketSummary;
        const msActive = ms.active_count ?? null;
        const msSold = ms.sold_count ?? null;
        const soldPrices = (ms.sold_low != null && ms.sold_high != null)
          ? ` ($${ms.sold_low}–$${ms.sold_high}, median $${ms.sold_median ?? '?'})`
          : '';
        const activeFloor = ms.active_lowest != null ? ` (floor $${ms.active_lowest})` : '';
        const activeGap = msActive === 0 && (s.activeUsed || 0) > 0;
        const soldGap = msSold != null && msSold < (s.soldUsed || 0) * 0.5 && (s.soldUsed || 0) > 4;
        lines.push(
          `- Model's own market summary: ${msSold ?? '?'} sold${soldPrices} · ${msActive ?? '?'} active${activeFloor}` +
          (activeGap ? ` ⚠️ model counted 0 active despite ${s.activeUsed} being fed — model classified them all as off-spec (accessories/parts/wrong-product)` : '') +
          (soldGap ? ` ⚠️ model counted only ${msSold} sold of ${s.soldUsed} fed — most were classified as off-spec` : ''),
        );
      }
    }
  }

  if (t.fit) {
    const f = t.fit;
    lines.push(`\n### Platform fit${ago(f.ts)}`);
    lines.push(`- ${f.platforms} platform(s) → ${f.good} good / ${f.unfit} unfit${modelTag(f.model)}`);
  }

  return `
## Marketplace Pipeline
${scope.note}> Last sell-side run's funnel (photo analysis → comp scrape → price synthesis →
> platform fit), captured in the main process so it survives SellHub deletion
> and log-buffer scroll — the sell-side analog of the Job Search Pipeline. The
> "found → fed to the model" gap in synthesis answers "did we use all the comps
> we found?": the top-25/15 cap is by-design; blocked sources, a null price, and
> a found≫unique gap (an extractor double-counting) are not. Per-source raw
> counts + the unique line localize a silent inflation; anti-bot blocks and
> internal scrape errors are reported separately (a browser-launch/profile-lock
> race is NOT a captcha). "Model's own market summary" is the final funnel step:
> active_count=0 despite N fed means the model classified every active listing as
> off-spec (accessories/parts). Each stage stamps independently (resolve/rescrape alone).

${lines.join('\n')}
`;
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

  // ── Job platform session snapshot ─────────────────────────────────────────
  // Same cache as sell-monitor; shown separately because job platforms have
  // different UI context (Settings → Job Boards). A verify URL returning 404
  // means the platform changed its URL structure — that's only visible here,
  // not in the sell-monitor section above.
  // Only include when this canvas actually has job nodes — don't bleed job
  // login state into a marketplace-only report.
  const hasJobNodes = (nodes || []).some(n => n?.type?.toLowerCase().startsWith('job'));
  let jobSessionsMarkdown = '';
  if (hasJobNodes) try {
    const platforms = getJobLoginPlatforms() || [];
    const cachePath = path.join(app.getPath('userData'), 'session-status-cache.json');
    let cache = {};
    try {
      const raw = fs.readFileSync(cachePath, 'utf8');
      cache = JSON.parse(raw) || {};
    } catch { /* file may not exist yet */ }

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
> Disk cache state for job-board logins — same \`session-status-cache.json\`
> as marketplace sessions. A verify URL returning 404 means the platform
> changed its URL structure; update \`verifyUrl\` in \`JOB_LOGIN_PLATFORMS\`
> in stealthBrowser.js. "No entry" = never logged in via the app.

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

  const jobsConfig = buildJobsConfigSnapshot();
  const jobsConfigMarkdown = `
## Job Search API Configuration
- USAJobs API key set: ${jobsConfig.hasUsajobsKey ? '✅' : '❌'}
- USAJobs Email set: ${jobsConfig.hasUsajobsEmail ? '✅' : '❌'}
- USAJobs key prefix: \`${jobsConfig.usajobsKeyPrefix}\`
`;

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
  try { scraperAdaptationMarkdown = buildScraperAdaptationSnapshot(); }
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

  let baseMarkdown = `
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
