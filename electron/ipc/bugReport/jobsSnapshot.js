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
      skipAI: JOB_SEARCH_TEST_MODE.skipAI || false,
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
export function buildJobsPipelineSnapshot(currentNodeIds, reportWindowId, canvasFilePath) {
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

    // Snippet length stats — answers "did we get full descriptions?" without
    // requiring a separate file read outside the bug report. Reads the saved
    // snapshot (written by SKIP_AI_FOR_TESTING and the normal scoring path)
    // and reports min/median/max per source. Empty-snippet jobs are flagged
    // with ⚠️ so truncated or unenriched sources surface immediately.
    // Also runs field-quality checks for salary/posted to catch selector
    // regressions (e.g. salary="Monday to Friday", posted all-empty).
    try {
      const snapPath = canvasFilePath
        ? path.join(path.dirname(canvasFilePath), 'job-search-last-scrape.json')
        : path.join(app.getPath('userData'), 'job-search', 'job-search-last-scrape.json');
      const snapData = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
      const snapJobs = Array.isArray(snapData?.jobs) ? snapData.jobs : [];
      if (snapJobs.length > 0) {
        const bySource = {};
        for (const j of snapJobs) {
          const src = j.source || 'unknown';
          if (!bySource[src]) bySource[src] = [];
          bySource[src].push((j.snippet || '').length);
        }
        const entries = Object.entries(bySource);
        if (entries.length === 1) {
          const [[, lens]] = entries;
          lens.sort((a, b) => a - b);
          const min = lens[0], median = lens[Math.floor(lens.length / 2)], max = lens[lens.length - 1];
          const empty = lens.filter(l => l === 0).length;
          const emptyFlag = empty > 0 ? ` ⚠️ ${empty} empty` : '';
          lines.push(`- Snippet lengths (saved snapshot): min ${min} / median ${median} / max ${max} chars${emptyFlag}`);
        } else {
          lines.push('- Snippet lengths per source (saved snapshot):');
          for (const [src, lens] of entries) {
            lens.sort((a, b) => a - b);
            const min = lens[0], median = lens[Math.floor(lens.length / 2)], max = lens[lens.length - 1];
            const empty = lens.filter(l => l === 0).length;
            const emptyFlag = empty > 0 ? ` ⚠️ ${empty} empty` : '';
            lines.push(`  - \`${src}\`: min ${min} / median ${median} / max ${max} chars${emptyFlag}`);
          }
        }

        // ── Field-quality checks ───────────────────────────────────────────
        // Salary: non-empty values that don't look monetary are selector
        // regressions (the DOM node picked up schedule/benefit text instead).
        // Posted: 100% empty on a source means the date selector broke.
        // URL: any missing URLs means jobs can't be opened or deduped properly.
        // Description: the full JD is stored in `snippet` on the saved
        // snapshot (existing snippet-length stats above already flag empty
        // counts). The additional signal here is "non-empty but very short" —
        // typically means the per-card description expansion silently fell
        // back to the listing-card excerpt. Per-query `X/Y expanded` log
        // lines otherwise need to be eyeballed to notice.
        // Fields like title/company/location are too free-form to validate here.
        const looksLikeMoney = (s) =>
          /\$|\d+\s*k\b|per (?:hour|year|week|month)|\/h(?:r|our)|\/yr|\/year|hourly|annually|\ba year\b|\ban hour\b/i.test(s);
        const SHORT_DESC_THRESHOLD = 400; // listing snippets are typically <300 chars

        const qualBySource = {};
        for (const j of snapJobs) {
          const src = j.source || 'unknown';
          const q = qualBySource[src] || (qualBySource[src] = {
            total: 0,
            salaryPresent: 0, salaryGarbage: 0, salaryGarbageEx: [],
            postedEmpty: 0,
            urlMissing: 0,
            companyEmpty: 0,
            titleEmpty: 0,
            descEmpty: 0, descShort: 0, descShortLens: [],
          });
          q.total++;
          const sal = (j.salary || '').trim();
          if (sal) {
            q.salaryPresent++;
            if (!looksLikeMoney(sal)) {
              q.salaryGarbage++;
              if (q.salaryGarbageEx.length < 3) q.salaryGarbageEx.push(`"${sal.slice(0, 50)}"`);
            }
          }
          if (!(j.posted || '').trim())  q.postedEmpty++;
          if (!(j.url || '').trim())     q.urlMissing++;
          if (!(j.company || '').trim()) q.companyEmpty++;
          if (!(j.title || '').trim())   q.titleEmpty++;
          // Full JD lives in `snippet` on the saved snapshot (the field is named
          // for the original list-card excerpt but is overwritten with the
          // expanded description). Two distinct failure modes:
          //   • empty  → enrichment never populated it (e.g. LinkedIn guest
          //     authwall hit mid-run, leaving the rest with no description),
          //   • short  → snippet-leak (listing-card text mistaken for full JD).
          const desc = (j.snippet || '').trim();
          if (!desc) {
            q.descEmpty++;
          } else if (desc.length < SHORT_DESC_THRESHOLD) {
            q.descShort++;
            if (q.descShortLens.length < 3) q.descShortLens.push(desc.length);
          }
        }

        let anyQualityIssue = false;
        for (const [src, q] of Object.entries(qualBySource)) {
          const issues = [];
          // Salary: reported against POPULATED count, not total — 158/158 garbage
          // is the alarming signal; 158/686 of total dilutes it. A source where
          // salary is legitimately rare (e.g. LinkedIn API) lights up correctly
          // only when the values it DOES carry are garbage.
          if (q.salaryGarbage > 0) {
            const pct = Math.round((q.salaryGarbage / q.salaryPresent) * 100);
            const sev = pct >= 80 ? '🔥' : '⚠';
            issues.push(
              `${sev} salary garbage: ${q.salaryGarbage}/${q.salaryPresent} (${pct}%) of present salaries are non-monetary` +
              ` — e.g. ${q.salaryGarbageEx.join(', ')} — check salary selector`,
            );
          }
          if (q.postedEmpty === q.total) {
            issues.push(`🔥 posted: ALL ${q.total} empty — date selector broken`);
          } else if (q.postedEmpty > 0 && q.postedEmpty / q.total >= 0.8) {
            issues.push(`⚠ posted: ${q.postedEmpty}/${q.total} (${Math.round((q.postedEmpty / q.total) * 100)}%) empty — date selector may be broken`);
          }
          if (q.titleEmpty > 0) {
            issues.push(`🔥 title missing: ${q.titleEmpty}/${q.total} — title selector broken`);
          }
          if (q.companyEmpty > 0 && q.companyEmpty / q.total >= 0.2) {
            issues.push(`⚠ company missing: ${q.companyEmpty}/${q.total} (${Math.round((q.companyEmpty / q.total) * 100)}%) — company selector may be intermittent`);
          }
          if (q.urlMissing > 0) {
            issues.push(`🔥 url missing: ${q.urlMissing}/${q.total} — broken card link, breaks dedup`);
          }
          // Empty descriptions: a high rate means enrichment broke for most jobs
          // (e.g. LinkedIn's guest authwall stops enrichment after a few requests,
          // leaving the remainder with no description). Reported as a hard issue so
          // the field-quality line can't bless a source that's 99% empty while the
          // snippet-length line above already screams "N empty".
          // Below ~10% empty is within normal enrichment-miss tolerance (and the
          // snippet-length line above still shows the exact empty count); only a
          // meaningful fraction warrants a field-quality flag.
          if (q.descEmpty / q.total >= 0.5) {
            issues.push(`🔥 description missing: ${q.descEmpty}/${q.total} (${Math.round((q.descEmpty / q.total) * 100)}%) empty — enrichment failed for most jobs (e.g. authwall mid-run)`);
          } else if (q.descEmpty / q.total >= 0.1) {
            issues.push(`⚠ description missing: ${q.descEmpty}/${q.total} (${Math.round((q.descEmpty / q.total) * 100)}%) empty — some jobs never got a description`);
          }
          if (q.descShort > 0) {
            const lensStr = q.descShortLens.join(', ');
            issues.push(`⚠ description short (<${SHORT_DESC_THRESHOLD} chars): ${q.descShort}/${q.total} — likely got the listing snippet instead of the full JD (sample lengths: ${lensStr})`);
          }
          if (issues.length > 0) {
            if (!anyQualityIssue) {
              lines.push('- ⚠️ **Field quality issues (scrape selectors may be broken):**');
              anyQualityIssue = true;
            }
            for (const msg of issues) {
              lines.push(`  - \`${src}\`: ${msg}`);
            }
          }
        }
        if (!anyQualityIssue && Object.keys(qualBySource).length > 0) {
          lines.push('- Field quality (saved snapshot): ✅ salary, posted, url, and snippet look correct');
        }
      }
    } catch { /* snapshot absent or unreadable — omit silently */ }
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
      // LinkedIn's Solve isn't a captcha-extract — it's an anonymous description
      // re-fetch (no login: descriptions come from cookieless guest pages, so the
      // session is irrelevant). Its own outcome fields render on a dedicated line.
      if (r.kind === 'linkedin-reenrich') {
        const rot = r.contextRotations != null ? `, ${r.contextRotations} ctx-rotation(s)` : '';
        if (r.skippedSameIp) {
          lines.push(`- \`${sourceId}\`${ago(r.ts)}: Solve → **skipped, IP unchanged**${r.warmIp ? ` (still ${r.warmIp})` : ''} — the VPN switch hadn't taken effect, so re-fetch was not re-attempted on the same rate-limited IP.`);
        } else if (r.walled) {
          lines.push(`- \`${sourceId}\`${ago(r.ts)}: Solve → re-fetch **hit IP ceiling** after +${r.enrichSuccess ?? 0}/${r.needEnrich ?? '?'}${rot}${r.stillEmpty != null ? `, ${r.stillEmpty} still empty` : ''}${r.warmIp ? `, IP ${r.warmIp} now warm` : ''}. _Anonymous guest rate-limit, not a login issue — switch VPN to a fresh IP, then Solve to fetch more._`);
        } else if (r.needEnrich != null) {
          lines.push(`- \`${sourceId}\`${ago(r.ts)}: Solve → re-fetched +${r.enrichSuccess ?? 0}/${r.needEnrich}${rot}${r.stillEmpty != null ? `, ${r.stillEmpty} still empty` : ''}`);
        } else {
          lines.push(`- \`${sourceId}\`${ago(r.ts)}: Solve → re-fetch (no jobs needed descriptions)`);
        }
        continue;
      }
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

  // LinkedIn anonymous-enrichment egress-IP trail. The guest description limit
  // is per-IP, so the whole "switch your VPN and Solve again" loop hinges on the
  // egress IP actually changing — the one variable the rest of this report is
  // blind to (the resolve telemetry keeps only the latest Solve and records no
  // IP). This block makes it explicit per pass: which IP it ran on, whether that
  // changed, and whether the lookup even worked. A null IP means the same-IP
  // guard is inert (it always proceeds); a never-changing IP means the VPN isn't
  // switching egress; distinct IPs that all still wall means the exit IPs are
  // shared/pre-warmed. Those three are indistinguishable without this.
  const enrichTrail = Array.isArray(t.linkedinEnrich) ? t.linkedinEnrich : [];
  if (enrichTrail.length > 0) {
    lines.push('\n### LinkedIn enrichment — egress IP trail');
    lines.push('> Guest description quota is per-IP. "Switch VPN → Solve" only helps if the egress IP actually changes.');
    let prevIp = null;
    for (const e of enrichTrail) {
      const kind = e.kind === 'solve' ? 'Solve' : 'search';
      let ipStr;
      if (e.ipOk === false) ipStr = '**IP lookup FAILED** (null)';
      else if (e.ip) {
        const changed = prevIp == null ? '' : (e.ip === prevIp ? ' **(unchanged ⚠)**' : ' (changed ✓)');
        ipStr = `IP ${e.ip}${changed}`;
      } else ipStr = 'IP not looked up (clean pass)';
      let outcome;
      if (e.skippedSameIp) outcome = 'skipped — same warm IP, not re-attempted';
      else if (e.walled) outcome = `walled, +${e.enriched ?? 0}${e.stillEmpty != null ? `, ${e.stillEmpty} still empty` : ''}${e.contextRotations != null ? `, ${e.contextRotations} rot` : ''}`;
      else outcome = `clean finish, +${e.enriched ?? 0}${e.stillEmpty ? `, ${e.stillEmpty} still empty` : ''}`;
      lines.push(`- ${kind}${ago(e.ts)}: ${ipStr} → ${outcome}`);
      if (e.ip) prevIp = e.ip;
    }
    // Cross-pass verdict — the actual answer to "is the IP switch working?".
    const solves = enrichTrail.filter(e => e.kind === 'solve');
    const seenIps = enrichTrail.filter(e => e.ip).map(e => e.ip);
    const distinctIps = new Set(seenIps);
    const nullLookups = enrichTrail.filter(e => e.ipOk === false).length;
    if (nullLookups > 0) {
      lines.push(`- ⚠️ **egress IP lookup failed on ${nullLookups} pass(es)** — api.ipify.org unreachable (a VPN may block it). The same-IP guard needs a non-null IP, so with these it silently proceeds every time and can NOT catch "you haven't switched yet."`);
    }
    if (solves.length >= 1 && seenIps.length >= 2 && distinctIps.size === 1) {
      lines.push(`- 🔥 **IP never changed across ${seenIps.length} passes (${[...distinctIps][0]})** — the VPN switch is NOT changing the egress IP LinkedIn sees. Re-Solving on the same warm IP just re-walls; the switch isn't working.`);
    } else if (solves.length >= 2 && distinctIps.size > 1 && solves.every(e => e.walled || e.skippedSameIp)) {
      lines.push(`- ℹ️ **${distinctIps.size} distinct IPs but every Solve still walled** — the IP IS changing, so the switch "works", but each exit IP is already rate-limited (shared/pre-warmed commercial-VPN endpoints). Switching can't reliably land a cold IP; a residential IP or waiting out the per-IP cooldown is the realistic path.`);
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
