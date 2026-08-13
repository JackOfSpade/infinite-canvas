import electronPkg from 'electron';
const { app } = electronPkg;
import fs from 'fs';
import path from 'path';
import { getJobsTelemetry } from '../jobs.js';
import { getApplicationTelemetry } from '../jobApplication.js';
import { getManualScraperTelemetry } from '../browser/manualScraper.js';
import { getJobsSettings } from '../settings.js';
import { modelResolutionSnapshot } from '../modelResolver.js';
import { appliedJobsSnapshot } from '../appliedJobs.js';
import { JOB_SEARCH_TEST_MODE } from '../../../src/utils/jobSourceScope.js';
import { MEDIUM_TEST, FULL_TEST, FAST_TEST, JOB_RESULT_CAP, JOB_PER_PAGE_CAP, JOB_PER_SOURCE_CAP, JOB_MAX_PAGES, JOB_TEST_QUERY_CAP, JOB_API_PER_SOURCE_CAP } from '../resultCaps.js';
import { ago, modelTag, pipelineScope, formatAge } from './helpers.js';
import { looksLikeMoney, hasMojibake, mojibakeExcerpt } from './jobQualityChecks.js';

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
      mode: FAST_TEST ? 'fast' : MEDIUM_TEST ? 'medium' : FULL_TEST ? 'full' : 'production',
      enabled: JOB_SEARCH_TEST_MODE.enabled,
      sourceId: JOB_SEARCH_TEST_MODE.sourceId || null,
      skipAI: JOB_SEARCH_TEST_MODE.skipAI || false,
      jobResultCap: JOB_RESULT_CAP,
      jobPerPageCap: JOB_PER_PAGE_CAP,
      jobPerSourceCap: JOB_PER_SOURCE_CAP,
      // FAST-mode breadth knobs (Infinity in other modes) so the report shows the
      // exact bound a fast run scraped under.
      jobMaxPages: JOB_MAX_PAGES,
      queryCap: JOB_TEST_QUERY_CAP,
      apiPerSourceCap: JOB_API_PER_SOURCE_CAP,
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
  const hasLinkedInEnrich = Array.isArray(t?.linkedinEnrich) && t.linkedinEnrich.length > 0;
  const hasBrowserScrape = !!browserScrape?.active || (browserScrape?.events || []).length > 0;
  let appGen = null;
  try { appGen = getApplicationTelemetry(); } catch { /* generator may not be loaded */ }
  // Model resolution (§8) and the applied-jobs store (§6) are both app-global —
  // neither is scoped to a job run, so they can carry signal even on a report
  // with no fresh search this session (e.g. "why did this posting never come
  // back" or "which model actually served the last mining pass"). Pulled here
  // (not gated behind appGen) so they still surface on that kind of report.
  let modelRes = null;
  try { modelRes = modelResolutionSnapshot(); } catch { /* resolver may not be loaded */ }
  let appliedSnap = null;
  try { appliedSnap = appliedJobsSnapshot(); } catch { /* store may not be loaded */ }
  const hasModelRes = !!(modelRes && (modelRes.fetchedAt > 0 || (modelRes.skipped || []).length > 0));
  const hasAppliedJobs = !!(appliedSnap && appliedSnap.count > 0);
  if (!t || (!t.search && !hasResolves && !hasLinkedInEnrich && !t.scoring && !t.bucketing && !t.history && !hasBrowserScrape && !appGen && !hasModelRes && !hasAppliedJobs)) return '';

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
    const dedup = s.dedupProvenance;
    if (dedup?.total > 0) {
      const summary = Object.entries(dedup.counts || {}).map(([reason, count]) => `${reason}=${count}`).join(', ');
      lines.push(`- Dedup provenance: ${dedup.total} drop(s)${summary ? ` · ${summary}` : ''}.`);
      for (const item of Array.isArray(dedup.entries) ? dedup.entries : []) {
        const kept = item.kept || {};
        const dropped = item.dropped || {};
        const keptId = kept.nativeId || kept.url || '(no listing ID)';
        const droppedId = dropped.nativeId || dropped.url || '(no listing ID)';
        lines.push(`  - \`${item.reason || 'unknown'}\`: kept ${kept.source || '?'} "${kept.title || '?'}" — ${kept.location || '(no location)'} [${keptId}] · dropped ${dropped.source || '?'} [${droppedId}]`);
      }
      if (dedup.omitted > 0) lines.push(`  - _${dedup.omitted} additional dedup drop(s) omitted from this bounded trace._`);
    }
    // Look-back window the run actually used + a per-platform verdict on whether
    // it bound each source. The window is enforced two ways: a server-side date
    // param (the source never serves out-of-window rows) AND a global client-side
    // filterJobsByAge over the merged results — but the client filter KEEPS any
    // job with an unparseable `posted`, so a source with neither a server param
    // nor a parseable per-job date is only bounded by its own query limits.
    // This block makes "did 7 days apply to ALL platforms?" answerable at a glance.
    if (s.maxAgeDays != null) {
      lines.push(`- **Look-back window: ${s.maxAgeDays} day(s)** — enforced server-side where the source takes a date param, and re-applied as a global client-side filter (the client filter can only bound a source that carries a parseable \`posted\` date).`);
    }
    if (s.ageBySource && Object.keys(s.ageBySource).length > 0) {
      lines.push(`- Per-source age outcome (dropped → kept · oldest surviving posting):`);
      for (const [k, a] of Object.entries(s.ageBySource)) {
        if ((a.kept || 0) === 0 && (a.dropped || 0) === 0) continue;
        const oldest = a.oldestKeptRaw ? `"${a.oldestKeptRaw}" (${a.oldestKeptDays}d)` : '—';
        let flag;
        if (a.oldestKeptDays != null && s.maxAgeDays != null && a.oldestKeptDays > s.maxAgeDays) {
          // A survivor older than the window means the client filter and the parse
          // disagree, or a source bypassed both — a genuine leak worth chasing.
          flag = ` 🔥 LEAK — kept a posting older than the ${s.maxAgeDays}d window`;
        } else if (a.kept > 0 && a.unparseableKept === a.kept) {
          // Every survivor had an unparseable/empty date — the client-side filter
          // was blind to this source, so its window is enforced SERVER-SIDE ONLY.
          flag = ` ⚠️ no parseable per-job date on any survivor — window enforced by the source's date param only (client backstop blind here)`;
        } else if (a.unparseableKept > 0) {
          flag = ` (${a.unparseableKept} survivor(s) had no parseable date — not client-checkable)`;
        } else {
          flag = ' ✅';
        }
        // Dice's date bound is conditional + its request URL isn't logged anywhere,
        // so annotate it inline: this is the only way to confirm the server-side
        // `filters.postedDate` actually fired (vs. falling back to client-side).
        const bound = (k === 'dice' && s.diceDateBound) ? ` · bound: ${s.diceDateBound}` : '';
        lines.push(`  - \`${k}\`: ${a.dropped} dropped → ${a.kept} kept · oldest kept ${oldest}${bound}${flag}`);
      }
    }
    // Target location: the typo-correction (raw → canonical), how each source
    // applied it (real param vs keyword-only vs remote-board), and an adherence
    // tally over the KEPT jobs — so "did 'denvr' get corrected?" and "was the
    // location adhered to per platform / why is a Miami role here?" are answerable.
    const loc = s.location;
    if (loc && (loc.rawInput || loc.canonical)) {
      if (loc.rawInput && loc.canonical && loc.rawInput.toLowerCase() !== loc.canonical.toLowerCase()) {
        lines.push(`- **Target location: "${loc.rawInput}" → "${loc.canonical}"** ${loc.corrected ? '(typo-corrected ✅)' : ''}`);
      } else {
        lines.push(`- **Target location: ${loc.canonical || loc.rawInput || '(none)'}**${loc.rawInput && !loc.canonical ? ' ⚠️ raw input did not resolve to a canonical place' : ''}`);
      }
      if (loc.perSource && Object.keys(loc.perSource).length > 0) {
        lines.push('- Per-source location treatment (how each platform received the target):');
        for (const [k, treat] of Object.entries(loc.perSource)) lines.push(`  - \`${k}\`: ${treat}`);
      }
      const ad = loc.adherence;
      if (ad && ad.total > 0) {
        const pct = Math.round((ad.matched / ad.total) * 100);
        // Attribute off-targets to the RIGHT cause. A "soft" source (keyword-only
        // like Google, or a remote board) legitimately spills nearby/unrelated
        // roles. A "hard" source carrying a real location= param returning an
        // out-of-area role is either that source's own search radius (e.g. Dice
        // +30mi → metro suburbs, which are on-target in practice) or a genuine
        // leak — don't hand-wave it as "keyword-only".
        let offFlag = '';
        if (ad.offTarget > 0) {
          if (ad.country) {
            // Country-level target: an off-target is now only counted when the
            // listing names a DIFFERENT country's subdivision, so this figure is
            // a real cross-border leak and safe to state plainly. Locations with
            // no country signal at all land in `unclear` below instead.
            offFlag = ` — ⚠️ ${ad.offTarget} provably OUTSIDE ${ad.country} (cross-border leak; check the samples below)`;
          } else {
            const isSoft = (id) => /keyword-only|remote board/.test(loc.perSource?.[id] || '');
            const hard = Object.keys(ad.offBySource || {}).filter(id => !isSoft(id));
            offFlag = hard.length > 0
              ? ` — ⚠️ ${ad.offTarget} OUT-OF-AREA, incl. from real-param source(s) [${hard.join(', ')}] — likely that source's own search radius (e.g. Dice +30mi → nearby metro suburbs) or a genuine leak; check the samples below`
              : ` — ⚠️ ${ad.offTarget} OUT-OF-AREA (all from keyword-only / remote sources — best-effort; location-free query variants can surface these)`;
          }
        }
        // For a country target, "in-area" only means inside that country — say so,
        // so the reader doesn't read 50% as a city-level miss (it isn't).
        const scopeNote = ad.country ? ` (in-area = anywhere in ${ad.country})` : '';
        const unclearPart = ad.unclear > 0 ? `, ${ad.unclear} unclear` : '';
        lines.push(`- Location adherence over ${ad.total} kept job(s)${scopeNote}: ${ad.matched} in-area (${pct}%), ${ad.remote} remote, ${ad.offTarget} off-target${unclearPart}, ${ad.unknown} no-location${offFlag}`);
        if (ad.country) {
          lines.push(`  - ℹ️ Country-level target — "in-area" just means inside ${ad.country}. Search a city/province (e.g. "Toronto, Ontario") to tighten results and get city-level adherence.`);
        }
        if (ad.unclear > 0) {
          // Deliberately NOT counted as a leak. We can enumerate a country's
          // provinces/states but not its cities, so a bare city name ("Nanaimo")
          // is unclassifiable rather than foreign — calling it a leak sent a past
          // investigation after a bug that wasn't there. A HIGH unclear count
          // concentrated in one source is still worth a look: that source is
          // returning locations too bare to verify.
          const bySrc = Object.entries(ad.unclearBySource || {}).map(([k, v]) => `${k}=${v}`).join(', ');
          lines.push(`  - ℹ️ ${ad.unclear} unclear: the listing names a place with no ${ad.country} or foreign region token (usually a bare city name), so membership can't be decided either way — NOT counted as a leak${bySrc ? ` · by source: ${bySrc}` : ''}`);
          if (Array.isArray(ad.unclearSamples) && ad.unclearSamples.length > 0) {
            for (const ex of ad.unclearSamples) lines.push(`    - ${ex}`);
          }
        }
        if (Array.isArray(ad.offSamples) && ad.offSamples.length > 0) {
          lines.push('  - Off-target sample(s):');
          for (const ex of ad.offSamples) lines.push(`    - ${ex}`);
        }
      }
      if (Array.isArray(s.queryStrings) && s.queryStrings.length > 0) {
        lines.push('- Raw role queries (shared across sources):');
        for (const q of s.queryStrings) lines.push(`  - \`${q}\``);
      }
      if (Array.isArray(s.googleQueryStrings) && s.googleQueryStrings.length > 0) {
        lines.push('- Google keyword queries sent (canonical location appended when absent):');
        for (const q of s.googleQueryStrings) lines.push(`  - \`${q}\``);
      }
    }
    // RemoteOK and WWR are whole-feed sources with no server-side role query.
    // Show the exact title role concepts that admitted each surviving remote row, plus
    // RemoteOK's non-authoritative tags, so a report can distinguish a matcher
    // defect from a confusing board metadata field without dumping the whole feed.
    if (s.remoteRelevance && Object.keys(s.remoteRelevance).length > 0) {
      lines.push('- Remote-feed relevance trace (surviving jobs only; title matching — `service→support` denotes an adjacent role synonym, and RemoteOK tags are context, not match evidence):');
      for (const [sourceId, rows] of Object.entries(s.remoteRelevance)) {
        for (const row of rows) {
          const title = row?.title ? `"${row.title}"` : '(untitled)';
          const company = row?.company ? ` — ${row.company}` : '';
          const matches = Array.isArray(row?.matched) ? row.matched : [];
          const why = matches.map(m => {
            const terms = Array.isArray(m?.matchedConcepts)
              ? m.matchedConcepts.map(concept => `${concept?.queryTerm || '?'}${concept?.kind === 'synonym' ? `→${concept.matched || '?'}` : ''}`).join(', ')
              : (Array.isArray(m?.matchedTerms) ? m.matchedTerms.join(', ') : '—');
            const required = m?.requiredMatches ? `/${m.requiredMatches} required` : '';
            return `\`${m?.query || '?'}\` → [${terms}]${required}`;
          }).join('; ') || '(no match evidence recorded)';
          const tags = Array.isArray(row?.tags) && row.tags.length ? ` · tags: ${row.tags.join(', ')}` : '';
          lines.push(`  - [${sourceId}] ${title}${company}: ${why}${tags}`);
        }
      }
    }
    // Listing language: how many kept jobs came through in a non-English language
    // (e.g. fr.glassdoor.ca / Québec / EU postings). They're kept & scored as-is —
    // this is observability, not a filter — so a foreign listing that scored low
    // is explained by its language, not a scoring bug.
    const langs = s.languages;
    if (langs && langs.total > 0) {
      if (langs.nonEnglish > 0) {
        const parts = Object.entries(langs.byLang).map(([l, n]) => `${l}=${n}`).join(', ');
        lines.push(`- Listing language: ${langs.nonEnglish}/${langs.total} non-English (${parts}) — kept & scored as-is (the AI reads them; applying is the user's call)`);
        for (const l of Object.keys(langs.samples || {})) lines.push(`  - ${l}: ${langs.samples[l]}`);
      } else {
        lines.push(`- Listing language: all ${langs.total} kept job(s) English`);
      }
    }

    // Browser-scrape order this run + the per-source manual-solve history that
    // produced it. Sources that recently made the user solve a captcha/login run
    // first (so they're cleared while watched); clean/auto-handling sources sink.
    // Answers "why did Google scrape before Indeed?" — score = recent manual-solve
    // rate (EMA); needs ≥2 runs of data before it reorders off the default.
    if (Array.isArray(s.browserOrder) && s.browserOrder.length) {
      const v = s.verification || {};
      const annotated = s.browserOrder.map((id) => {
        const st = v[id];
        return st && st.samples >= 2 ? `${id}(${Math.round((st.score || 0) * 100)}% manual)` : id;
      });
      lines.push(`- Browser scrape order (manual-verification-first): ${annotated.join(' → ')}`);
    }

    // Per-source raw counts — the "was this source silently not gathered?" line.
    // A 0 WITH a warning is a real miss to chase; a clean 0 is genuinely-empty or
    // off-category (e.g. a cinematographer on USAJobs/Dice). Without this you only
    // saw the aggregate raw count and couldn't tell which sources contributed.
    if (s.bySource && Object.keys(s.bySource).length > 0) {
      const entries = Object.entries(s.bySource);
      const got = entries.filter(([, v]) => v.count > 0).map(([k, v]) => `${k}=${v.count}`);
      lines.push(`- Per source (raw gathered): ${got.length ? got.join(', ') : '(none)'}`);
      // Date-bounded deep pagination: how deep each paginating source walked and
      // why it stopped. `empty-page` = the source ran out of results. `blocked`
      // = an anti-bot wall cut it short. `page-cap` = hit JOB_MAX_PAGES with jobs
      // still coming. `per-source-cap` = an intentional aggregate result ceiling
      // (not an exhausted source). One-shot/API sources have no walk and don't
      // appear here.
      const walked = entries.filter(([, v]) => v.pagesWalked > 0);
      for (const [k, v] of walked) {
        let flag = '';
        if (v.stopReason === 'blocked') {
          flag = ' ⚠️';
        } else if (v.stopReason === 'per-source-cap') {
          const limit = v.cap?.limit;
          const capLabel = Number.isFinite(limit) ? ` (${limit})` : '';
          flag = ` ⚠️ (stopped by the per-source cap${capLabel} — this source may have additional in-window jobs; ${v.cap?.type === 'per-source' ? 'disable fast mode to widen' : 'raise the configured source cap to widen'}.)`;
        } else if (v.stopReason === 'page-cap') {
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
      // API/feed sources don't paginate. When a source MATCHED more than it
      // surfaced, that overflow was never gathered: in FAST mode it is the
      // aggregate per-source cap; otherwise it is the extractor result cap.
      // gathered is set only for API sources; > count = truncated.
      const apiCapped = entries.filter(([, v]) => v.gathered != null && v.gathered > v.count);
      for (const [k, v] of apiCapped) {
        const overflow = v.gathered - v.count;
        const fastCap = v.cap?.type === 'fast-aggregate';
        const limit = v.cap?.limit;
        const capLabel = Number.isFinite(limit) ? ` (${limit})` : '';
        const nextStep = fastCap
          ? 'disable fast mode to widen'
          : 'raise JOB_RESULT_CAP to widen';
        lines.push(`  - \`${k}\`: surfaced ${v.count} of ${v.gathered} in-window matches ⚠️ (${fastCap ? 'fast aggregate cap' : 'result cap'}${capLabel} — ${overflow} more matched but not gathered; ${nextStep})`);
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
        // looksLikeMoney / MOJIBAKE_RE moved to jobQualityChecks.js (extracted
        // pure functions, unit-testable directly instead of only via a full
        // bug-report payload) — see that file for the salary/mojibake rationale.
        const SHORT_DESC_THRESHOLD = 400; // listing snippets are typically <300 chars
        // Per-source salary expectation — gates the "0 salaries at all" alarm so it
        // never cries wolf on sources that structurally omit salary. Grounded in
        // the extractors (electron/extractors/apiExtractors.js + electron/extractors/jobs.js):
        //   NEVER  — extractor has no pay path at all (hardcoded salary:''):
        //            linkedin (guest API), greenhouse, lever boards.
        //   ALWAYS — carry comp on ~every posting (PositionRemuneration): usajobs.
        //   else   — OPTIONAL: postings legitimately omit pay, so 0% is only suspicious
        //            on a sample big enough that a normal batch would surface ≥1. This
        //            now INCLUDES ziprecruiter (DOM "Estimated pay" chip), weworkremotely
        //            (parsed from the RSS description), and google (aria-label salary) —
        //            all gained best-effort extraction, so a clean 0% IS worth flagging.
        const SALARY_NEVER = new Set(['linkedin', 'greenhouse', 'lever']);
        const SALARY_ALWAYS = new Set(['usajobs']);
        const ZERO_SALARY_MIN_SAMPLE = 20;

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
            mojibake: 0, mojibakeEx: [],
          });
          q.total++;
          // Encoding corruption (C1 controls) in any user-facing field.
          const blob = `${j.title || ''} ${j.company || ''} ${j.snippet || ''}`;
          if (hasMojibake(blob)) {
            q.mojibake++;
            if (q.mojibakeEx.length < 1) {
              const excerpt = mojibakeExcerpt(blob);
              if (excerpt) q.mojibakeEx.push(excerpt);
            }
          }
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
          // Zero-salary alarm — scoped to what THIS source is expected to carry.
          // Skipped entirely for NEVER sources (0% is correct there). Hard for
          // ALWAYS sources (0% means the parse broke). Soft for OPTIONAL sources,
          // and only above a sample size where a healthy batch would surface ≥1.
          if (q.salaryPresent === 0 && !SALARY_NEVER.has(src)) {
            if (SALARY_ALWAYS.has(src)) {
              issues.push(`🔥 salary: 0/${q.total} present — this source carries pay on ~every posting, so a clean sweep means the salary parse/selector broke`);
            } else if (q.total >= ZERO_SALARY_MIN_SAMPLE) {
              issues.push(`⚠ salary: 0/${q.total} present — a source that normally surfaces some pay returned NONE across the whole batch; salary selector likely regressed`);
            }
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
          // Encoding corruption — UTF-8 read as Latin-1 ("'"→"â€™", em-dash→"â€"",
          // 𝗯𝗼𝗹𝗱-Unicode). Corrupts the text fed to scoring AND the generated
          // résumé, and (before the gate fix) tricked language detection. NOT legit
          // accents (é/à/ç) — only C1 control bytes that never occur in real text.
          if (q.mojibake > 0) {
            const pct = Math.round((q.mojibake / q.total) * 100);
            const ex = q.mojibakeEx[0] ? ` — e.g. "…${q.mojibakeEx[0]}…"` : '';
            issues.push(`⚠ mojibake / encoding corruption: ${q.mojibake}/${q.total} (${pct}%) descriptions contain UTF-8-as-Latin-1 artifacts — corrupts scoring + generated résumé text${ex}`);
          }
          // Truncation/cap signature: non-empty descriptions clustered in a TIGHT
          // band at a modest length — e.g. Dice's ~500-char list `summary` when
          // detail enrichment silently falls back. Distinct from `descShort`
          // (<400): a 500-char cap clears that threshold but still isn't a full JD.
          // Real JDs vary widely (1k–10k), so a tight cluster across several jobs
          // is a cap, not natural variance.
          const lens = (bySource[src] || []).filter(l => l > 0).slice().sort((a, b) => a - b);
          if (lens.length >= 3) {
            const lo = lens[0], hi = lens[lens.length - 1];
            if (hi >= 200 && hi <= 1200 && (hi - lo) <= 40) {
              issues.push(`⚠ descriptions look capped/uniform: ${lens.length} non-empty all ~${hi} chars (${lo}–${hi}) — likely a length cap or summary-fallback, not full JDs`);
            }
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
        // Salary coverage — always surfaced, NOT gated on a garbage warning. The
        // garbage check only fires on PRESENT salaries that fail looksLikeMoney,
        // so "no warning" is vacuous when a source carries no salary at all (e.g.
        // LinkedIn's guest API never returns salary — fetch hardcodes salary='',
        // and enrichment extracts only the description, not baseSalary). Printing
        // present/total makes "selector fine, source just omits salary" distinct
        // from "we're silently dropping salaries we should have".
        const covParts = [];
        for (const [src, q] of Object.entries(qualBySource)) {
          const pct = q.total ? Math.round((q.salaryPresent / q.total) * 100) : 0;
          let note;
          if (q.salaryPresent === 0) {
            note = SALARY_NEVER.has(src)
              // NOT "the source has no salary" — these sites DO show pay; our
              // extractor just doesn't capture it (ZR: ItemList JSON-LD is name+url
              // only, enrichment pulls description not baseSalary; WWR: RSS has no
              // salary field; Google: panel salary chip unread). A known extraction
              // gap, not a regression — and a backlog item, not a clean ✅.
              ? 'none carried — our extractor doesn’t capture pay for this source yet (known gap, not a regression)'
              : 'none carried — no salary values to validate';
          }
          else if (q.salaryGarbage === 0) note = 'all monetary ✅';
          else note = `${q.salaryGarbage} non-monetary ⚠ (see field-quality issue above)`;
          covParts.push(`\`${src}\`: ${q.salaryPresent}/${q.total} present (${pct}%) — ${note}`);
        }
        if (covParts.length === 1) {
          lines.push(`- Salary coverage (saved snapshot): ${covParts[0]}`);
        } else if (covParts.length > 1) {
          lines.push('- Salary coverage (saved snapshot):');
          for (const p of covParts) lines.push(`  - ${p}`);
        }
        if (!anyQualityIssue && Object.keys(qualBySource).length > 0) {
          lines.push('- Field quality (saved snapshot): ✅ posted, url, and snippet look correct (salary coverage above)');
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
      // Anti-bot challenge diagnostics — present when a challenge fired. These rank
      // the cause: a datacenter/hosting egress IP points at IP reputation; the
      // browser profile rules out "wasn't headful"; the incident ID aids vendor
      // cross-reference. Without these, diagnosing a block needs source + a screenshot.
      if (a.browserProfile) lines.push(`  - Browser: ${a.browserProfile}`);
      if (a.egressIp) {
        // isp/org is the real datacenter-vs-residential tell (a VPN like Proton
        // shows isp "Proton AG" even though ip-api's hosting flag says false). The
        // ⚠ flag fires only on a positive hosting hit; we never assert "residential".
        const who = [a.egressIsp, a.egressOrg]
          .filter(Boolean)
          .filter((v, i, arr) => arr.indexOf(v) === i)
          .join(' · ');
        const hostingNote = a.egressHosting === true ? ' · **datacenter/hosting ⚠** (anti-bots flag these on sight)' : '';
        lines.push(`  - Egress IP: ${a.egressIp}${who ? ` · ${String(who).slice(0, 90)}` : ''}${hostingNote}`);
      }
      if (a.blockId) lines.push(`  - Anti-bot incident ID: ${a.blockId}`);
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
        } else if (r.browserUnavailable) {
          lines.push(`- \`${sourceId}\`${ago(r.ts)}: Solve → **browser/profile contention — retryable**${r.stillEmpty != null ? ` (${r.stillEmpty} still empty)` : ''}. Close the other captcha/login window, then Solve again; no LinkedIn descriptions were fetched in this pass.`);
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
        // The host alone cannot distinguish a user who successfully reached
        // Glassdoor's results/home page from one who closed on the login or
        // challenge URL. These are captured by the visible resolve window
        // immediately before close (when available), and make a manual close
        // actionable instead of the ambiguous "never-extracted, textLen 0".
        if (d.finalUrl) bits.push(`final URL: \`${String(d.finalUrl).replace(/`/g, "'").slice(0, 500)}\``);
        if (d.finalTitle) bits.push(`final title: "${String(d.finalTitle).replace(/[\r\n]+/g, ' ').replace(/"/g, "'").slice(0, 180)}"`);
        if (d.hostMismatch) bits.push(`probe skipped: ${d.probeSkippedReason || 'host-mismatch'}`);
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
    lines.push('\n### LinkedIn enrichment — egress IP / browser trail');
    lines.push('> Guest quota is per-IP OR per-browser-session. "Switch VPN → Solve" only helps if it\'s per-IP — the browser# + lifetime columns separate the two.');
    lines.push('> To MEASURE the cooldown: stay on one IP (no Re-run), Solve at progressively longer waits — the "idle" column is the gap before each pass; the first pass that returns **clean finish** (no wall) marks the cooldown.');
    // Compact gap formatter: minutes once past 60s, else seconds.
    const fmtGap = (ms) => ms >= 60000 ? `${Math.round(ms / 60000)}m` : `${Math.round(ms / 1000)}s`;
    let prevIp = null;
    let prevTs = null;
    for (const e of enrichTrail) {
      const kind = e.kind === 'solve' ? 'Solve' : e.kind === 'probe' ? 'probe' : 'search';
      // Idle gap before this pass = time the limit was left to cool = this pass's
      // START minus the previous pass's END. Using startedAt (not ts, the end)
      // excludes a clean pass's own multi-minute enrichment from the gap.
      const idleMs = prevTs != null ? ((e.startedAt ?? e.ts) - prevTs) : null;
      const idleStr = idleMs != null ? ` · +${fmtGap(Math.max(0, idleMs))} idle` : '';
      let ipStr;
      if (e.ipOk === false) ipStr = '**IP lookup FAILED** (null)';
      else if (e.ip) {
        const changed = prevIp == null ? '' : (e.ip === prevIp ? ' **(unchanged ⚠)**' : ' (changed ✓)');
        ipStr = `IP ${e.ip}${changed}`;
      } else ipStr = 'IP not looked up (clean pass)';
      // Per-pass no-desc, split soft-block (recoverable) vs genuine (permanent).
      // Surfacing it here is what makes cross-pass transience visible — e.g. a pass
      // reporting "40 no-desc [38 soft-block]" followed by one reporting "8 no-desc"
      // proves the soft-blocks were rate-limit artifacts, not missing descriptions.
      const nd = e.noDesc ?? 0;
      const ndStr = nd > 0
        ? `, ${nd} no-desc${e.noDescSoftBlock != null ? ` [${e.noDescSoftBlock} soft-block${e.noDescGenuine ? `, ${e.noDescGenuine} genuine` : ''}]` : ''}`
        : '';
      let outcome;
      if (e.skippedSameIp) outcome = 'skipped — same warm IP, not re-attempted';
      else if (e.browserUnavailable) outcome = `**browser/profile contention — retryable**${e.stillEmpty != null ? `, ${e.stillEmpty} still empty` : ''} · close the other captcha/login window, then Solve`;
      // Dead egress (VPN landed on a server with no internet) — distinct from a
      // rate-limit wall: every fetch failed at the transport layer. The remedy is
      // a DIFFERENT (working) VPN server, not waiting out a cooldown.
      else if (e.noInternet) outcome = `🔌 **no internet on this IP** (egress offline) — +${e.enriched ?? 0}${e.stillEmpty != null ? `, ${e.stillEmpty} still empty` : ''}${ndStr} · switch to a WORKING VPN server, then Solve`;
      else if (e.walled) outcome = `walled, +${e.enriched ?? 0}${e.stillEmpty != null ? `, ${e.stillEmpty} still empty` : ''}${ndStr}${e.contextRotations != null ? `, ${e.contextRotations} rot` : ''}`;
      // No URL wall, but soft-blocks (gutted pages) mean it was still rate-limited —
      // don't call that a "clean finish", it overstates what happened.
      else if ((e.noDescSoftBlock || 0) > 0) outcome = `**soft-blocked finish** (no URL wall, but gutted pages), +${e.enriched ?? 0}${e.stillEmpty ? `, ${e.stillEmpty} still empty` : ''}${ndStr}`;
      else outcome = `**clean finish (cold)**, +${e.enriched ?? 0}${e.stillEmpty ? `, ${e.stillEmpty} still empty` : ''}${ndStr}`;
      // Browser identity: which process this pass ran on + how much it had already
      // enriched on that process. Same browser# with rising lifetime across passes
      // is what lets a reader separate browser-session depletion from IP.
      let browserStr = '';
      if (e.browserGen != null) {
        const ageS = e.browserAgeMs != null ? `${Math.round(e.browserAgeMs / 1000)}s old` : 'age ?';
        browserStr = ` · browser#${e.browserGen} (${ageS}, lifetime ${e.browserLifetimeBefore ?? 0}→${e.browserLifetimeAfter ?? 0})`;
      }
      lines.push(`- ${kind}${ago(e.ts)}${idleStr}: ${ipStr} → ${outcome}${browserStr}`);
      if (e.ip) prevIp = e.ip;
      prevTs = e.ts;
    }
    // Cross-pass verdict — "did the IP change work, and is the limit IP- or
    // browser-scoped?".
    const solves = enrichTrail.filter(e => e.kind === 'solve');
    const seenIps = enrichTrail.filter(e => e.ip).map(e => e.ip);
    const distinctIps = new Set(seenIps);
    const nullLookups = enrichTrail.filter(e => e.ipOk === false).length;
    // Real enrichment passes (tied to a browser generation) — the skip pass has none.
    const realPasses = enrichTrail.filter(e => e.browserGen != null);
    const gens = new Set(realPasses.map(e => e.browserGen));
    const ipChangedAcrossPasses = new Set(realPasses.filter(e => e.ip).map(e => e.ip)).size > 1;
    if (nullLookups > 0) {
      lines.push(`- ⚠️ **egress IP lookup failed on ${nullLookups} pass(es)** — api.ipify.org unreachable (a VPN may block it). The same-IP guard needs a non-null IP, so with these it silently proceeds every time and can NOT catch "you haven't switched yet."`);
    }
    // Strongest discriminator: same browser process across passes, IP changed
    // between them, yet yield collapsed → switching the IP did NOT restore
    // headroom, so the ceiling is browser/session-scoped, not per-IP.
    if (realPasses.length >= 2 && gens.size === 1 && ipChangedAcrossPasses) {
      const first = realPasses[0], last = realPasses[realPasses.length - 1];
      if ((first.enriched ?? 0) > (last.enriched ?? 0) * 2) {
        lines.push(`- 🔬 **Same browser process (gen #${[...gens][0]}) across all passes, yet yield collapsed ${first.enriched}→${last.enriched} while the egress IP changed** — switching the IP did NOT restore headroom on the same browser. That points to a **browser/session-scoped** limit (reset by Reset browser session / app restart), NOT per-IP. Caveat: the first pass is also the freshest browser, so the decisive test is: **Reset browser session (or restart) on the SAME IP** — if yield recovers, it's the browser, not the IP.`);
      }
    } else if (solves.length >= 1 && seenIps.length >= 2 && distinctIps.size === 1) {
      lines.push(`- 🔥 **IP never changed across ${seenIps.length} passes (${[...distinctIps][0]})** — the VPN switch is NOT changing the egress IP LinkedIn sees. Re-Solving on the same warm IP just re-walls; the switch isn't working.`);
    } else if (solves.length >= 2 && distinctIps.size > 1 && solves.every(e => e.walled || e.skippedSameIp)) {
      lines.push(`- ℹ️ **${distinctIps.size} distinct IPs but every Solve still walled** — could be shared/pre-warmed exit IPs (per-IP, switch can't find a cold one) OR a browser-session limit. Compare the browser# column: same browser# across all ⇒ lean browser-scoped; fresh browser# that still walls on a new IP ⇒ lean per-IP.`);
    }
    // Cooldown bracket: pair the idle-before-each-pass with its outcome to bound
    // how long the limit needs to cool. A real enrichment pass (browserGen set)
    // that came back clean after some idle ⇒ cooled by then; the longest idle
    // that still walled is the lower bound.
    const fmtGap2 = (ms) => ms >= 60000 ? `${Math.round(ms / 60000)}m` : `${Math.round(ms / 1000)}s`;
    const walledIdles = [];
    const cleanIdles = [];
    for (let i = 1; i < enrichTrail.length; i++) {
      const e = enrichTrail[i];
      if (e.browserGen == null) continue; // skip the same-IP-skip pass (no run)
      if (e.kind === 'probe') continue;   // probe confirms have 0s idle by design — don't skew the bracket
      if (e.noInternet) continue;         // offline egress is neither cooled nor walled — not a cooldown signal
      const idle = Math.max(0, (e.startedAt ?? e.ts) - enrichTrail[i - 1].ts);
      // A soft-blocked pass (gutted pages, no URL wall) was STILL rate-limited —
      // not cooled — so it bounds the cooldown from below just like a wall does.
      // Only a pass with neither a wall nor soft-blocks proves the limit had cleared.
      const wasRateLimited = e.walled || (e.noDescSoftBlock || 0) > 0;
      if (wasRateLimited) walledIdles.push(idle);
      else if (!e.skippedSameIp) cleanIdles.push(idle); // truly clean = cooled
    }
    if (cleanIdles.length > 0) {
      const minClean = Math.min(...cleanIdles);
      const walledBelow = walledIdles.filter(w => w < minClean);
      if (walledBelow.length > 0) {
        const loStr = fmtGap2(Math.max(...walledBelow));
        const hiStr = fmtGap2(minClean);
        // When both bounds round to the same label (e.g. ~61s walled vs ~62s clean
        // both render "1m"), "between 1m and 1m" reads as a contradiction — collapse
        // it to a single estimate instead.
        if (loStr === hiStr) {
          lines.push(`- 🧊 **Cooldown ≈ ${hiStr}** — around ${hiStr} idle was the boundary: a shorter wait still walled, this one came back clean (cold). Wait ≥ ${hiStr} between batches to keep enriching on the same IP/browser.`);
        } else {
          lines.push(`- 🧊 **Cooldown ≈ between ${loStr} and ${hiStr}** — a Solve after ${loStr} idle still walled, but after ${hiStr} idle it came back clean (cold). Wait ≥ that between batches to keep enriching on the same IP/browser.`);
        }
      } else {
        lines.push(`- 🧊 **Cooldown ≤ ${fmtGap2(minClean)}** — a Solve after ${fmtGap2(minClean)} idle came back clean (cold). Try shorter waits to tighten the bound.`);
      }
    } else if (walledIdles.length > 0) {
      lines.push(`- ⏳ **Cooldown > ${fmtGap2(Math.max(...walledIdles))}** (longest idle tested so far) — every Solve still walled. Wait longer between Solves (same IP, no Re-run) until one returns "clean finish".`);
    }
    // Automated cooldown-probe result (JOB_SEARCH_PROBE_COOLDOWN) — the crisp
    // answer when the probe ran the wait-and-test loop unattended.
    const cd = t.linkedinCooldown;
    if (cd) {
      if (cd.running) {
        lines.push(`- ⏳ **Cooldown probe in progress** — ${cd.attempts} attempt(s) so far${cd.aborted ? ' (aborted)' : ''}.`);
      } else if (cd.foundMs != null) {
        lines.push(`- ✅ **Cooldown confirmed: ~${fmtGap2(cd.foundMs)}** — initial probe + confirmations all clean after ${fmtGap2(cd.foundMs)} idle on the same IP/browser (${cd.attempts} attempt(s) total). Wait ≥ that between enrichment batches to keep going without switching anything.`);
      } else if (cd.browserUnavailable) {
        lines.push(`- ⏸️ **Cooldown probe paused — browser/profile contention.** A visible captcha/login window held the shared browser profile at attempt ${cd.attempts}; close it and retry. This result says nothing about LinkedIn's cooldown.`);
      } else if (cd.aborted) {
        lines.push(`- ⏹️ **Cooldown probe aborted** after ${cd.attempts} attempt(s) — no clearing wait found yet.`);
      } else {
        const maxMs = Array.isArray(cd.waitsMs) && cd.waitsMs.length ? Math.max(...cd.waitsMs) : 0;
        lines.push(`- ❌ **Cooldown probe exhausted** ${cd.attempts} attempt(s) (idle waits up to ${fmtGap2(maxMs)}) without clearing — the cooldown is longer than that, or idle alone won't clear it (try a longer schedule / Reset browser session / residential IP).`);
      }
    }
    // Residual verdict — the durable answer to "did we get every description?".
    // Derived from the LAST real pass so it survives the log ring buffer rolling.
    //
    // The decisive split is soft-block vs genuine no-desc. A real LinkedIn job page
    // ALWAYS carries JobPosting JSON-LD, so a no-desc with title="" + 0 JSON-LD
    // (noDescSoftBlock) is a rate-limit artifact — recoverable on a later pass —
    // NOT a posting that lacks a description. Only noDescGenuine is permanent.
    // The earlier version of this verdict treated ALL no-desc as permanent and
    // declared "complete" on any clean finish; that was wrong — soft-blocks don't
    // trip the URL wall, so a "clean finish" can still be strangling recoverable
    // jobs. evalErrors is NOT used (it counts failed ATTEMPTS, not empty jobs).
    const lastAttempt = enrichTrail[enrichTrail.length - 1];
    if (lastAttempt?.browserUnavailable) {
      lines.push(`- ⚠️ **Residual: ${lastAttempt.stillEmpty ?? '?'} still empty — retryable browser/profile contention.** The final enrichment pass could not start because another visible captcha/login window held the shared browser profile. Close that window, then Solve; this was not a clean finish or an IP-rate-limit result.`);
    } else {
      const lastReal = [...enrichTrail].reverse().find(e => e.browserGen != null);
      if (lastReal && lastReal.stillEmpty != null) {
      const empty = lastReal.stillEmpty;
      if (empty === 0) {
        lines.push('- ✅ **Residual: 0 still empty** — every job that has a description got one.');
      } else if (lastReal.noDescSoftBlock != null) {
        const soft = lastReal.noDescSoftBlock || 0;
        const genuine = lastReal.noDescGenuine || 0;
        const genuineNote = genuine > 0 ? ` (${genuine} are genuinely description-less)` : '';
        if (lastReal.walled) {
          lines.push(`- ⚠️ **Residual: ${empty} still empty — NOT complete.** The final pass **walled** (stopped early) so some jobs were never attempted; the last pass also saw ${soft} soft-block(s) (gutted pages under rate-limit — recoverable). Wait the cooldown and re-enrich${genuineNote}.`);
        } else if (soft > 0) {
          lines.push(`- ⚠️ **Residual: ${empty} still empty — likely NOT complete.** The final pass was a "clean finish" (no URL wall) but still returned **${soft} soft-block(s)** — gutted pages served under rate-limit, NOT missing descriptions, and recoverable on another pass. Enrichment stopped before these cleared; re-run or extend passes to recover them${genuineNote}.`);
        } else {
          lines.push(`- ✅ **Residual: ${empty} still empty — complete.** Clean finish, **0 soft-blocks** — the remainder is genuinely description-less (real pages with no JobPosting description) or a few transient load failures. Nothing recoverable by waiting; a re-run would only retry transient errors.`);
        }
      } else if (lastReal.noDesc != null) {
        // Pre-split telemetry: noDesc present but not classified. Can't tell
        // soft-block from genuine, so DON'T claim "complete" on a clean finish.
        const noDesc = Math.min(lastReal.noDesc, empty);
        const other = Math.max(0, empty - noDesc);
        lines.push(`- ⚠️ **Residual: ${empty} still empty** (final pass ${lastReal.walled ? 'walled — stopped early' : 'clean finish'}): ${noDesc} no-desc${other > 0 ? ` · ${other} other` : ''}. ⚠ This build predates the soft-block split, so it's unknown how many no-desc are rate-limit soft-blocks (recoverable) vs genuinely description-less — re-run on a current build to classify.`);
      } else {
        // No no-desc telemetry at all — fall back to the wall flag.
        lines.push(`- ${lastReal.walled ? '⚠️' : '✅'} **Residual: ${empty} still empty** (final pass ${lastReal.walled ? 'walled — stopped early, some jobs unreached' : 'clean finish — every job attempted'}).`);
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
    if (s.failureReason) {
      // Persisted from the scoring loop so the cause survives even after the raw
      // log line scrolls out of the main-process ring buffer.
      lines.push(`  - ↳ batch failure reason: \`${s.failureReason}\``);
    }
    if (s.placeholders > 0) {
      lines.push(`- ⚠️ **${s.placeholders} placeholder score(s)** — these jobs reached the scorer but came back unusable and were given a default matchScore=50. They were NOT genuinely analyzed.`);
    }
    if (s.unscored > 0) {
      lines.push(`- ⚠️ **${s.unscored} job(s) never scored** — the abort signal cut the batch loop short before they were sent to the scorer.`);
    }
  } else {
    lines.push('\n### Scoring\n- (no scoring recorded this session)');
  }

  if (t.history && typeof t.history === 'object') {
    lines.push('\n### Seen-history persistence');
    const stages = [
      ['preScoring', 'Authoritative search write'],
      ['postScoring', 'Post-scoring resolve reconciliation'],
    ];
    for (const [key, label] of stages) {
      const h = t.history[key];
      if (!h) continue;
      const age = ago(h.ts);
      if (h.error) {
        lines.push(`- ❌ ${label}${age}: ${h.input} job(s) → history write failed: \`${h.error}\``);
      } else if (h.skipped) {
        lines.push(`- ℹ️ ${label}${age}: ${h.input} job(s) → skipped (${h.skipped})`);
      } else {
        lines.push(`- ✅ ${label}${age}: ${h.input} job(s) → ${h.written || 0} new history row(s)${h.pruned ? `, ${h.pruned} expired row(s) pruned` : ''}`);
        // WHY the rest produced no row. "59 jobs → 50 rows" on an EMPTY history
        // is the shape of a dedup key that can't tell two listings apart, and
        // without this breakdown it reads as ordinary dedup: it took replaying a
        // saved run to find that all 10 Google jobs shared one normalized URL.
        // `in-batch` is the tell — a collision with an earlier job in the SAME
        // write, i.e. over-collapsing, not a genuine already-seen repost.
        const sk = h.skips;
        if (sk && (sk.url || sk.titleCompany || sk.noKey)) {
          const parts = [];
          if (sk.url) parts.push(`${sk.url} by url-key`);
          if (sk.titleCompany) parts.push(`${sk.titleCompany} by title+company[+location]`);
          if (sk.noKey) parts.push(`${sk.noKey} with no usable key`);
          const bySrc = Object.entries(sk.bySource || {}).map(([k, v]) => `${k}=${v}`).join(', ');
          const total = (sk.url || 0) + (sk.titleCompany || 0) + (sk.noKey || 0);
          lines.push(`  - ${total} job(s) wrote no row: ${parts.join(', ')}${bySrc ? ` · by source: ${bySrc}` : ''}`);
          if (sk.inBatch > 0) {
            lines.push(`    - ⚠️ ${sk.inBatch} of those collided with ANOTHER JOB IN THIS SAME WRITE, not with prior history — that is a dedup key too coarse to separate two distinct listings, and those jobs will also be wrongly suppressed as "already seen" on the next run.`);
          }
        }
        if (h.unreadable > 0) {
          lines.push(`  - ⚠️ ${h.unreadable} row(s) already in the CSV could not be parsed back (a legacy row containing a newline, e.g. a Glassdoor company captured as "Marshalls\\n3.4"). They are invisible to dedup and are dropped by this rewrite; the jobs re-append cleanly, so the file self-heals from here.`);
        }
      }
    }
  }

  if (t.bucketing) {
    const b = t.bucketing;
    // The taxonomy = the labels for the 3-level results tree (likelihood band →
    // salary range → role). Bands/ranges are placed deterministically by the
    // renderer (can't drop jobs); only the ROLE partition is the AI's, so the
    // placement check is on roles.
    lines.push(`\n### Taxonomy (likelihood → salary → role)${ago(b.ts)}`);
    if (b.error) {
      // The bucket call threw (Claude "streaming required", truncation, or
      // fallback-chain exhaustion). The renderer flat-spawned the jobs. Surface
      // it so this is never mistaken for a clean run OR the "never ran" null slot.
      lines.push(`- ❌ **Taxonomy FAILED** on ${b.input} scored job(s)${modelTag(b.model)} — jobs were spawned as a FLAT, score-ordered list (none dropped, but the likelihood/salary/role tree is lost).`);
      lines.push(`  - Error: ${b.error}`);
    } else {
      const clean = b.missing === 0 && b.duplicated === 0;
      lines.push(`- Input: ${b.input} → ${b.roleCount} role(s), ${Array.isArray(b.bandSummary) ? b.bandSummary.length : 0} likelihood band(s), ${Array.isArray(b.salaryRangeLabels) ? b.salaryRangeLabels.length : 0} salary range(s)${clean ? ' · ✅ every job placed in a role' : ''}${modelTag(b.model)}`);
      const dirs = t.scoring?.directions;
      if (typeof dirs === 'number' && dirs > 0 && b.roleCount > 0) {
        const note = dirs > b.roleCount
          ? ` (merged ${dirs - b.roleCount} away — ${dirs} scorer directions → ${b.roleCount} roles)`
          : ' (no merging needed)';
        lines.push(`  - Roles consolidated from ${dirs} distinct scorer careerDirection(s)${note}.`);
      }
      if (b.missing > 0) {
        const idxNote = Array.isArray(b.missingIndices) && b.missingIndices.length > 0
          ? ` Missing indices (0-based): [${b.missingIndices.join(', ')}]`
          : '';
        lines.push(`  - ⚠️ **${b.missing} job(s) NOT placed in any role by the AI** (common on the weak fallback models quota forces). The renderer sweeps them into an "Other" role — shown, not dropped.${idxNote}`);
      }
      if (b.duplicated > 0) {
        lines.push(`  - ⚠️ ${b.duplicated} job(s) placed in more than one role by the AI (first wins on spawn).`);
      }
      // Likelihood bands (top level, ordered high→low) with deterministic counts.
      if (Array.isArray(b.bandSummary) && b.bandSummary.length > 0) {
        lines.push('- Likelihood bands (top level — by interview %):');
        for (const band of b.bandSummary) {
          lines.push(`  - **${band.label}** — ${band.count} job${band.count === 1 ? '' : 's'}`);
        }
      }
      // Salary ranges (second level) — just the labels the AI chose.
      if (Array.isArray(b.salaryRangeLabels) && b.salaryRangeLabels.length > 0) {
        lines.push(`- Salary ranges (second level): ${b.salaryRangeLabels.map(s => `"${s}"`).join(', ')}`);
      }
      if (Array.isArray(b.taxonomyRepairs) && b.taxonomyRepairs.length > 0) {
        lines.push(`- ⚠️ Taxonomy validation repaired: ${b.taxonomyRepairs.join('; ')}.`);
      }
      if (Array.isArray(b.taxonomyAudit) && b.taxonomyAudit.length > 0) {
        lines.push('- Taxonomy placement audit (raw salary → annualized pay → deterministic buckets):');
        for (const item of b.taxonomyAudit) {
          const title = item.title ? `"${item.title}"` : '(untitled)';
          const source = item.source ? ` [${item.source}]` : '';
          const raw = item.rawSalary ? `"${item.rawSalary}"` : '(none)';
          const annual = item.annualSalary > 0 ? `$${Number(item.annualSalary).toLocaleString('en-US')}/yr` : 'unparseable';
          lines.push(`  - #${item.index} ${title}${source} — ${raw} → ${annual} → **${item.salaryRange || 'Unspecified'}**; ${item.likelihood || 'Match'}; ${item.role || 'Other'}`);
          if (item.salaryAnomaly) {
            const lo = Number(item.salaryAnomaly.lowerAnnual || 0).toLocaleString('en-US');
            const hi = Number(item.salaryAnomaly.upperAnnual || 0).toLocaleString('en-US');
            lines.push(`    - ⚠️ salary-range anomaly: $${lo}–$${hi}/yr (${item.salaryAnomaly.reason || 'implausibly wide range'}). Kept the lower endpoint for deterministic placement; verify the source chip.`);
          }
          // Only for values mined out of the description body: shows whether the
          // figure was actually the role's pay or a bonus/equity/revenue number
          // that happened to sit next to a cadence word.
          if (item.salaryContext) lines.push(`    - in-JD context: …${item.salaryContext}…`);
        }
        if (b.taxonomyAuditOmitted > 0) lines.push(`  - _${b.taxonomyAuditOmitted} additional job(s) omitted from this compact audit._`);
      }
      // Roles (third level) — the AI's creative partition; the part most worth
      // auditing ("are these the right labels, with the right jobs?").
      if (Array.isArray(b.roleSummary) && b.roleSummary.length > 0) {
        lines.push('- Roles (third level — is each label a sensible home for its jobs?):');
        for (const r of b.roleSummary) {
          const samples = Array.isArray(r.sampleTitles) && r.sampleTitles.length
            ? ` · e.g. ${r.sampleTitles.map(s => `"${s}"`).join(', ')}`
            : '';
          lines.push(`  - **${r.name}** — ${r.count} job${r.count === 1 ? '' : 's'}${samples}`);
        }
      }
      if (b.roleCount === 0 && b.input > 0) {
        lines.push('- ⚠️ Taxonomy returned 0 roles — the renderer will have fallen back to a flat spawn (jobs still shown, but the tree is lost).');
      }
    }
  } else {
    lines.push('\n### Taxonomy (likelihood → salary → role)\n- (no taxonomy recorded this session)');
  }

  // ── Application generation (last) ──────────────────────────────────────────
  // The model's actual résumé markup + cover-letter fields — the one place an
  // application rendering bug shows (stray mid-sentence newline, literal \n/\t,
  // broken structure). Fields are JSON.stringify'd so whitespace/escapes are
  // visible literally (a real newline shows as \n, a double-escaped one as \\n).
  if (appGen) {
    const a = appGen;
    const cl = a.coverLetter || {};
    const escScan = (s) => /\\[a-z]/.test(String(s ?? '')) ? ' ⚠️ literal backslash-escape present' : '';
    lines.push(`\n### Application Generation (last)${ago(a.ts)}`);
    lines.push(`- Job: ${a.jobTitle || '(untitled)'} @ ${a.company || '(no company)'}${a.nodeId ? ` · node ${a.nodeId}` : ''}`);
    // Achievement ledger (résumé design §3.6) — reused-vs-mined tells apart the
    // amortized-cost case from the pay-once-per-hub case; the stats line is the
    // only place a silent refute-drop or evidence-miss is visible at all.
    const ach = a.achievements || {};
    const achSourceLabel = {
      reused: 'reused from hub cache', mined: 'freshly mined this generation',
      unavailable: 'unavailable — careerData-only fallback', none: 'not passed by renderer',
    }[ach.source] || ach.source || 'unknown';
    lines.push(`- Achievement ledger: ${achSourceLabel} · kept ${ach.kept ?? 0} item(s)${ach.minedBy ? ` · miner \`${ach.minedBy.miner || '?'}\` refuter \`${ach.minedBy.refuter || '?'}\`` : ''}`);
    // Local render → page-count → fit loop (jobApplication.js's
    // renderResumeWithFit / resumeRender.js, SKILL.md §5) — the only place a
    // "why did I get a 2-page résumé" or "why is there no PDF" question is
    // answerable: attempts shows exactly what was tried (density per attempt,
    // measured page count or the error that aborted it) in generation order.
    if (a.render) {
      const r = a.render;
      // fontsLoaded is per-attempt (renderPdf's document.fonts.ready-plus-
      // display-family check, resumeRender.js) and absent on error-path
      // entries (never got far enough to check) — folded into each attempt so
      // a "#1=3p" that actually rendered in fallback fonts doesn't look
      // identical to a genuine good render.
      const attemptsStr = (Array.isArray(r.attempts) ? r.attempts : [])
        .map((att) => `#${att.attempt}${att.density ? `[${att.density}]` : ''}=${att.error ? `error(${att.error})` : `${att.pageCount}p${att.fontsLoaded === false ? '[fonts-unloaded]' : ''}`}`)
        .join(', ');
      lines.push(`- Résumé render/fit: target ${r.targetPageCount ?? '?'}p · ${r.initialPageCount ?? '?'}→${r.finalPageCount ?? '?'}p${r.compactApplied ? ' · compact applied' : ''}${r.revisionApplied ? ' · 1 length-revision call' : ''} · ${r.pdfProduced ? 'PDF produced' : '⚠️ no PDF (HTML-only)'}`);
      if (attemptsStr) lines.push(`  - attempts: ${attemptsStr}`);
      if (!r.pdfProduced && r.error) lines.push(`  - ⚠️ ${r.error}`);
      // The single most important line in this section: without it, "no PDF
      // because fonts never loaded" renders identically to "no PDF because
      // rendering broke" (both show pdfProduced:false, error:null) — a reader
      // would go hunting for a render bug that doesn't exist instead of
      // recognizing a network condition that resolves itself the next time
      // the machine has a clean path to fonts.googleapis.com.
      if (r.fontsLoaded === false) {
        lines.push('  - ⚠️ Web fonts failed to load (fonts.googleapis.com unreachable) — likely offline, a corporate proxy, or an ad-blocker blocking Google Fonts. Any PDF from this run was discarded (fallback-typeface PDFs never ship) and the fit loop skipped straight to ship (a page count measured in fallback fonts is meaningless). This is a network condition, not a render bug.');
      }
    }
    if (ach.stats) {
      const s = ach.stats;
      lines.push(`  - mined ${s.mined ?? 0} → dropped-by-refute ${s.droppedByRefute ?? 0}, demoted-by-check ${s.demotedByCheck ?? 0}, evidence-misses ${s.evidenceMisses ?? 0}`);
      // claim-figure-leaks (§3.2 telemetry, achievementLedger.js) never demotes
      // confidence and touches no other counter above — without its own line
      // a miner that leaked a self-computed figure into `claim` text would be
      // invisible in every report despite the check running and catching it.
      // date/direction misses surfaced alongside it for the same reason: both
      // are advisory-only (never gate, per computeLedger's doc-comment) so
      // neither shows up anywhere else either.
      lines.push(`  - claim-figure-leaks ${s.claimFigureLeaks ?? 0}, date-misses ${s.dateMisses ?? 0}, direction-misses ${s.directionMisses ?? 0}`);
    }
    if (ach.skipped) lines.push(`  - ⚠️ ${ach.skipped}`);
    lines.push(`- Résumé markup: ${a.resumeHtmlLen || 0} chars${escScan(a.resumeHtmlSample)}`);
    lines.push('- Cover-letter fields (JSON.stringify — whitespace/escapes shown literally):');
    lines.push(`  - salutation: ${JSON.stringify(cl.salutation || '')}`);
    lines.push(`  - recipient: ${JSON.stringify(cl.recipient || '')}`);
    if (Array.isArray(cl.contact) && cl.contact.length) lines.push(`  - contact: ${JSON.stringify(cl.contact)}`);
    const paras = Array.isArray(cl.paragraphs) ? cl.paragraphs : [];
    paras.forEach((p, i) => lines.push(`  - paragraph[${i}]: ${JSON.stringify(String(p ?? ''))}`));
    lines.push(`  - closing: ${JSON.stringify(cl.closing || '')}`);
    if (cl.signatureTitle) lines.push(`  - signatureTitle: ${JSON.stringify(cl.signatureTitle)}`);
    if (a.resumeHtmlSample) {
      lines.push('- Résumé markup sample (first 1500 chars):');
      lines.push('```html');
      lines.push(a.resumeHtmlSample);
      lines.push('```');
    }
  }

  // ── Model resolution (§8) ───────────────────────────────────────────────────
  // Kept to a line or two on purpose (clipboard-cap discipline — see
  // clipboardCap.js's logs+events tail floor; this section sits ahead of that
  // floor so it must stay cheap). The skip list is the whole point: a model
  // that silently failed the capability gate and fell to next-newest looks
  // IDENTICAL to "no new generation happened" unless it's named here.
  if (modelRes) {
    const r = modelRes.resolved || {};
    const age = modelRes.fetchedAt ? formatAge(modelRes.fetchedAt) : 'never resolved this run — pinned floor in use';
    lines.push(`\n### Model Resolution (Claude family tokens)`);
    lines.push(`- OPUS \`${r.OPUS || '?'}\` · SONNET \`${r.SONNET || '?'}\` · HAIKU \`${r.HAIKU || '?'}\` · source: ${modelRes.source || 'floor'} · resolved ${age} · epoch ${modelRes.epoch ?? 0}`);
    if (Array.isArray(modelRes.skipped) && modelRes.skipped.length > 0) {
      lines.push(`  - ⚠️ Skipped: ${modelRes.skipped.map(s => `\`${s.id}\` (${s.family}: ${s.reason})`).join('; ')}`);
    }
  }

  // ── Applied jobs store (§6) ─────────────────────────────────────────────────
  // Global and permanent — the only way to answer "why did this job never come
  // back in search" (it's silently filtered at every gather site once marked).
  if (appliedSnap) {
    const last = appliedSnap.lastAppliedAt ? `${appliedSnap.lastAppliedAt} (${formatAge(Date.parse(appliedSnap.lastAppliedAt))})` : 'never';
    lines.push(`\n### Applied Jobs Store`);
    lines.push(`- ${appliedSnap.count} job(s) marked applied · store: \`${appliedSnap.path || '?'}\` · last applied: ${last}`);
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
