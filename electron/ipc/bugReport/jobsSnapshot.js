import electronPkg from 'electron';
const { app } = electronPkg;
import fs from 'fs';
import path from 'path';
import { getJobsTelemetry } from '../jobs.js';
import { getManualScraperTelemetry } from '../browser/manualScraper.js';
import { getJobsSettings } from '../settings.js';
import { JOB_SEARCH_TEST_MODE } from '../../../src/utils/jobSourceScope.js';
import { MEDIUM_TEST, FULL_TEST, JOB_RESULT_CAP, JOB_PER_PAGE_CAP } from '../resultCaps.js';
import { ago, modelTag, pipelineScope } from './helpers.js';

export function buildJobsConfigSnapshot() {
  let jobs = {};
  try { jobs = getJobsSettings() || {}; } catch { /* settings store may not be ready */ }

  const usajobsKey = jobs.usajobsApiKey;
  const usajobsEmail = jobs.usajobsEmail;
  const scrapflyKey = jobs.scrapflyApiKey;
  const keyPrefix = usajobsKey ? `${String(usajobsKey).slice(0, 5)}…` : '(none)';
  const scrapflyKeyPrefix = scrapflyKey ? `${String(scrapflyKey).slice(0, 8)}…` : '(none)';

  return {
    hasUsajobsKey: !!usajobsKey,
    hasUsajobsEmail: !!usajobsEmail,
    usajobsKeyPrefix: keyPrefix,
    hasScrapflyKey: !!scrapflyKey,
    scrapflyKeyPrefix,
    testMode: {
      mode: MEDIUM_TEST ? 'medium' : FULL_TEST ? 'full' : 'production',
      enabled: JOB_SEARCH_TEST_MODE.enabled,
      sourceId: JOB_SEARCH_TEST_MODE.sourceId || null,
      jobResultCap: JOB_RESULT_CAP,
      jobPerPageCap: JOB_PER_PAGE_CAP,
    },
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
export function buildJobsPipelineSnapshot(currentNodeIds, reportWindowId) {
  let t;
  try { t = getJobsTelemetry(); } catch { return ''; }
  let browserScrape = null;
  try { browserScrape = getManualScraperTelemetry(); } catch { /* scraper may not be loaded */ }
  const hasResolves = t && t.resolves && Object.keys(t.resolves).length > 0;
  const hasBrowserScrape = !!browserScrape?.active || (browserScrape?.events || []).length > 0;
  if (!t || (!t.search && !hasResolves && !t.scoring && !t.bucketing && !hasBrowserScrape)) return '';

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
      const zeroWarn = entries
        .filter(([, v]) => v.count === 0 && v.warning)
        .map(([k, v]) => {
          const evidence = v.warning?.evidence ? ` — ${String(v.warning.evidence).slice(0, 220)}` : '';
          return `${k} (${v.warning.code})${evidence}`;
        });
      const zeroClean = entries.filter(([, v]) => v.count === 0 && !v.warning).map(([k]) => k);
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

  if (hasBrowserScrape) {
    lines.push('\n### Active Browser Scrape');
    const a = browserScrape.active;
    if (a) {
      const ageMs = Date.now() - (a.ts || Date.now());
      const bits = [
        a.phase ? `phase ${a.phase}` : null,
        a.srcName || a.sourceId ? `source ${a.srcName || a.sourceId}` : null,
        a.queryIndex && a.queryTotal ? `query ${a.queryIndex}/${a.queryTotal}` : null,
        a.pageNum ? `page ${a.pageNum}` : null,
        a.count != null ? `count ${a.count}` : null,
        `updated ${Math.max(0, Math.round(ageMs / 1000))}s ago`,
      ].filter(Boolean);
      lines.push(`- Current: ${bits.join(' · ')}`);
      if (a.url) lines.push(`  - URL: ${String(a.url).slice(0, 240)}`);
      if (a.reason) lines.push(`  - Reason: ${a.reason}`);
      if (a.key) lines.push(`  - Key: ${a.key}`);
      if (a.evidence) lines.push(`  - Evidence: ${String(a.evidence).slice(0, 360)}`);
      if (a.pageState) {
        lines.push(`  - Page state: ${JSON.stringify(a.pageState).slice(0, 360)}`);
      }
    } else {
      lines.push('- Current: (no active scrape)');
    }
    const recent = (browserScrape.events || []).slice(-8);
    if (recent.length > 0) {
      lines.push('- Recent browser-scrape phases:');
      for (const e of recent) {
        const ageMs = Date.now() - (e.ts || Date.now());
        // Chrome-spawn/connect phases get extra fields surfaced directly in the
        // report so the reader immediately knows pid/alive/poll-count without
        // having to cross-reference the raw log.
        const isChromephase = typeof e.phase === 'string' && e.phase.startsWith('chrome-');
        const label = [
          e.phase || 'event',
          e.srcName || e.sourceId || null,
          e.queryIndex && e.queryTotal ? `q${e.queryIndex}/${e.queryTotal}` : null,
          e.pageNum ? `p${e.pageNum}` : null,
          e.key ? `key=${e.key}` : null,
          isChromephase && e.pid != null    ? `pid=${e.pid}`                                    : null,
          isChromephase && e.outcome        ? `outcome=${e.outcome}`                             : null,
          isChromephase && e.alive != null  ? `alive=${e.alive}`                                 : null,
          isChromephase && e.polls != null  ? `polls=${e.polls}`                                 : null,
          isChromephase && e.elapsedMs != null ? `elapsed=${(e.elapsedMs / 1000).toFixed(1)}s`  : null,
          isChromephase && e.error          ? `err=${e.error}`                                   : null,
          isChromephase && e.stderr         ? `stderr=${String(e.stderr).slice(0, 200)}`          : null,
          `-${Math.max(0, Math.round(ageMs / 1000))}s`,
        ].filter(Boolean).join(' ');
        lines.push(`  - ${label}`);
      }
    }
  }

  // Browser-side console errors / network failures captured by the Puppeteer
  // stealth page — the signals that used to require manual DevTools export.
  const consoleLogs   = browserScrape?.consoleLogs   || [];
  const networkErrors = browserScrape?.networkErrors || [];
  if (consoleLogs.length > 0 || networkErrors.length > 0) {
    lines.push('\n### Browser Console & Network Errors');
    lines.push('> Captured automatically from the Puppeteer stealth page. Timestamps are seconds before this report was generated.');
    if (networkErrors.length > 0) {
      lines.push('**Network:**');
      for (const e of networkErrors.slice(-20)) {
        const ageS = Math.max(0, Math.round((Date.now() - e.ts) / 1000));
        const detail = e.status ? `HTTP ${e.status}` : e.errorText;
        lines.push(`- [-${ageS}s] ${e.method} ${e.url} → ${detail}`);
      }
    }
    if (consoleLogs.length > 0) {
      lines.push('**Console:**');
      for (const e of consoleLogs.slice(-40)) {
        const ageS = Math.max(0, Math.round((Date.now() - e.ts) / 1000));
        const src = e.url ? ` (${e.url.split('/').pop().slice(0, 60)}${e.line != null ? `:${e.line}` : ''})` : '';
        lines.push(`- [-${ageS}s] [${e.type}] ${e.text}${src}`);
      }
    }
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
    const sessionGathered = (t.search?.kept || 0) +
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
