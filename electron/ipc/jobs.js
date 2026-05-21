/**
 * Jobs IPC handlers — resume parsing, multi-source job search, AI scoring.
 * 12 Sources: Google, Indeed, LinkedIn, RemoteOK, WeWorkRemotely,
 *             ZipRecruiter, Glassdoor, Dice, Wellfound,
 *             Greenhouse API, Lever API, USAJobs API
 */
import { callLLMDocument, callLLMText } from './llm.js';
import { JOB_SCORING_SCHEMA, JOB_BUCKETING_SCHEMA, RESUME_PARSE_SCHEMA, JOB_QUERY_GENERATION_SCHEMA, INTERVIEW_PREP_SCHEMA } from './aiSchemas.js';
import { handleSafe } from './ipcUtils.js';
import { scrapeMultiple } from './browserPool.js';
import { openCaptchaResolveWindow } from './browser/authWindows.js';
import { jobScoringBatchSize, HEAVY_WAF_QUERY_CAP, DEFAULT_QUERY_CAP, JOB_SCORE_CAP } from './resultCaps.js';
import { logger } from '../logger.js';
import {
  GOOGLE_JOBS_EXTRACTOR, GOOGLE_JOBS_CONFIG,
  INDEED_JOBS_EXTRACTOR, INDEED_CONFIG,
  ZIPRECRUITER_EXTRACTOR, ZIPRECRUITER_CONFIG,
  GLASSDOOR_EXTRACTOR, GLASSDOOR_CONFIG,
  WELLFOUND_EXTRACTOR, WELLFOUND_CONFIG,
} from '../extractors/jobs.js';
import {
  fetchLinkedInJobs,
  fetchGreenhouseJobs,
  fetchLeverJobs,
  fetchUSAJobs,
  fetchRemoteOKJobs,
  fetchWeWorkRemotelyJobs,
  fetchDiceListings,
  buildGeoTermSet,
} from '../extractors/apiExtractors.js';
import { loadJobsHistory, appendJobsHistory, dedupAgainstHistory } from './jobsHistory.js';
import { filterJobsByAge } from './jobDateFilter.js';
import { getJobsSettings } from './settings.js';

const DEFAULT_MAX_AGE_DAYS = 21;
// Sentinel score for jobs the AI couldn't score (missing from the batch result,
// or a whole batch that failed to parse). NOT adaptive: a fixed midpoint marks
// "unscored" rather than asserting a real fit — the bug-report telemetry counts
// these (placeholderCount) so a scoring failure stays visible instead of being
// laundered into a plausible number.
const UNSCORED_FALLBACK_SCORE = 50;

// ── Pipeline telemetry ───────────────────────────────────────────────────────
// Records the last job-search funnel so the bug reporter can answer "did we
// analyze all the jobs we found?" without depending on (a) the renderer node
// tree, which vanishes the instant the user deletes the hub, or (b) the 60-line
// log ring buffer, which scrolls. Each stage stamps its own slot independently
// because the stages are separate IPC calls that don't always run together
// (e.g. a captcha-resolve scores pendingJobs with no fresh search). Mirrors
// gemini.js's getGeminiTelemetry().
const jobsTelemetry = {
  search:    null, // { ts, queries, raw, deduped, ageDropped, historyDropped, kept }
  resolves:  {},   // { [sourceId]: { ts, extracted, ageDropped, historyDropped, kept } }
                   // keyed so a multi-source recovery (e.g. Indeed then LinkedIn)
                   // keeps every resolve; re-resolving a source replaces its
                   // entry. Reset when a fresh search stamps so it's scoped to it.
  scoring:   null, // { ts, input, scored, placeholders, batches, failedBatches, unscored }
  bucketing: null, // { ts, input, categories }
};

export function getJobsTelemetry() {
  return jobsTelemetry;
}

// All source IDs — defines the complete set for progress tracking and reporting.
const ALL_SOURCE_IDS = [
  'google', 'indeed', 'linkedin', 'remoteok', 'weworkremotely',
  'ziprecruiter', 'glassdoor', 'dice', 'wellfound',
  'greenhouse', 'lever', 'usajobs',
];

// Sources that moved from browser pool to direct API (per deep research report):
// - remoteok: Open JSON API at remoteok.com/api (zero WAF)
// - weworkremotely: RSS feed at weworkremotely.com/remote-jobs.rss (zero WAF)

// Google Jobs chip parameter: closest discrete bucket ≥ requested age.
// Sources that take a raw day count get the number unmodified.
function googleDateChip(days) {
  if (days <= 1) return 'today';
  if (days <= 3) return '3days';
  if (days <= 7) return 'week';
  return 'month';
}

// ── Source → URL + Extractor + Config mapping (DOM scrape sources only) ──────
// LinkedIn has been moved to the API pool (fetchLinkedInJobs) — no Puppeteer needed.
function buildJobTasks(queries, maxAgeDays, profileLocations = []) {
  const days = Math.max(1, Math.floor(maxAgeDays || DEFAULT_MAX_AGE_DAYS));
  const gChip = googleDateChip(days);
  // Wellfound is the one browser source whose URL is a /role/{slug} SEO page, not
  // a free-text search box. The query carries the candidate's city ("Cinematographer
  // Denver"), and slugging the whole thing produced "/role/cinematographer-denver"
  // — not a real role slug, so the page returned nothing and we logged a misleading
  // "genuinely empty" 0. Same principle as the board-source geo fix: strip the
  // candidate's own location tokens from the role identifier (location is a filter,
  // not part of the role). The location-aware search sources (Indeed/Glassdoor/Zip/
  // Google) keep the city below — they WANT it as a query term.
  const geoTerms = buildGeoTermSet(profileLocations);
  const roleSlug = (q) => String(q).toLowerCase().split(/\s+/)
    .filter(tok => tok && !geoTerms.has(tok.replace(/[^a-z0-9]/g, '')))
    .join('-');
  // Browser pool extractors — only platforms that REQUIRE Puppeteer rendering.
  // RemoteOK and WeWorkRemotely have been moved to fetchApiSources (direct HTTP).
  //
  // `pages` = how many result pages to fetch per query variant (bounded). Page 1
  // alone is only the platform's relevance top-N — for a broad query it can be a
  // small slice of what's actually in the look-back window, so the surfaced "best
  // matches" are picked from an unrepresentative pool. Fetching a 2nd page widens
  // that pool. We DON'T deep-paginate or touch heavy-WAF sources: the rate
  // limiter's per-domain cooldown spaces page requests (the "delay" that keeps
  // slow pagination from looking like a burst), MAX_PER_DOMAIN=1 serializes them,
  // and a blocked/empty page-2 is dropped by the anti-bot detector — so this is a
  // bounded, self-throttling, gracefully-degrading widen, verifiable live.
  // `urlFn(q, page)` builds the page-`page` (0-based) URL; sources that can't
  // paginate via a URL param (Google's embedded jobs widget) ignore `page`.
  const extractors = {
    google:          { extractor: GOOGLE_JOBS_EXTRACTOR,  config: GOOGLE_JOBS_CONFIG,  pages: 1,
                       urlFn: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}&ibp=htl;jobs&htichips=date_posted:${gChip}` },
    indeed:          { extractor: INDEED_JOBS_EXTRACTOR,  config: INDEED_CONFIG,       pages: 2,
                       urlFn: (q, page) => `https://www.indeed.com/jobs?q=${encodeURIComponent(q)}&fromage=${days}${page > 0 ? `&start=${page * 10}` : ''}` },
    ziprecruiter:    { extractor: ZIPRECRUITER_EXTRACTOR, config: ZIPRECRUITER_CONFIG, pages: 1, // heavy WAF — single page
                       urlFn: (q) => `https://www.ziprecruiter.com/jobs-search?search=${encodeURIComponent(q)}&days=${days}` },
    glassdoor:       { extractor: GLASSDOOR_EXTRACTOR,    config: GLASSDOOR_CONFIG,    pages: 1, // heavy WAF — single page
                       urlFn: (q) => `https://www.glassdoor.com/Job/jobs.htm?sc.keyword=${encodeURIComponent(q)}&fromAge=${days}` },
    wellfound:       { extractor: WELLFOUND_EXTRACTOR,    config: WELLFOUND_CONFIG,    pages: 2,
                       urlFn: (q, page) => `https://wellfound.com/role/${roleSlug(q)}${page > 0 ? `?page=${page + 1}` : ''}` },
  };

  const tasks = [];
  // Remote-only boards get fewer queries; heavy WAF sites get only the first query.
  for (const [sourceId, { extractor, config, urlFn, pages = 1 }] of Object.entries(extractors)) {
    const isHeavyWAF = sourceId === 'ziprecruiter' || sourceId === 'glassdoor';
    const querySubset = isHeavyWAF ? queries.slice(0, HEAVY_WAF_QUERY_CAP) : queries.slice(0, DEFAULT_QUERY_CAP);

    // Flat index per source across (query × page) so `id` stays `${sourceId}-${n}`
    // and `res.id.replace(/-\d+$/, '')` still maps a task result back to its source.
    let idx = 0;
    for (const q of querySubset) {
      for (let page = 0; page < pages; page++) {
        tasks.push({
          id: `${sourceId}-${idx++}`,
          sourceId,
          page,            // 0-based; surfaced as per-page yield in the funnel
          url: urlFn(q, page),
          extractorJS: extractor,
          options: config,
        });
      }
    }
  }
  return tasks;
}

/**
 * Pick the top `n` jobs FAIRLY across sources (round-robin), preserving each
 * source's gathered order (≈ platform relevance, page 1 before page 2) within
 * its turn. Caps how many jobs reach the quota-bound LLM scorer when a widened
 * gather over-fills the budget, so we score "the best slice across all sources"
 * instead of letting whichever source returned most monopolize the scoring
 * budget. Returns all jobs unchanged when there are <= n.
 */
function selectTopAcrossSources(jobs, n) {
  const arr = Array.isArray(jobs) ? jobs : [];
  if (n <= 0) return [];
  if (arr.length <= n) return arr;
  const groups = new Map();
  for (const j of arr) {
    const k = j?.source || 'unknown';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(j);
  }
  // Deterministic source order (larger groups first, then name) so the cut
  // doesn't depend on source-arrival order; gather order is kept within a group.
  const sources = [...groups.keys()].sort((a, b) => {
    const d = groups.get(b).length - groups.get(a).length;
    return d !== 0 ? d : (a < b ? -1 : a > b ? 1 : 0);
  });
  const picked = [];
  const cursor = new Map(sources.map(s => [s, 0]));
  let advanced = true;
  while (picked.length < n && advanced) {
    advanced = false;
    for (const s of sources) {
      if (picked.length >= n) break;
      const g = groups.get(s);
      const i = cursor.get(s);
      if (i < g.length) { picked.push(g[i]); cursor.set(s, i + 1); advanced = true; }
    }
  }
  return picked;
}

/**
 * Fetch API-based sources in parallel (no Puppeteer needed).
 * @returns {{ sourceId: string, jobs: object[], error?: string }[]}
 */
async function fetchApiSources(queries, sender, signal = null, nodeId = null, maxAgeDays = DEFAULT_MAX_AGE_DAYS, profileLocations = []) {
  const firstQuery = queries[0] || '';
  // Source credentials come from Settings (electron-store) with a legacy
  // process.env fallback handled inside getJobsSettings() for users still
  // on the old .env config.
  const { usajobsApiKey: apiKey, usajobsEmail: email } = getJobsSettings();
  const days = Math.max(1, Math.floor(maxAgeDays || DEFAULT_MAX_AGE_DAYS));

  // Keyword-less company-board / remote-feed sources keyword-filter client-side
  // against the query. The query carries the candidate's city ("… Denver"), and
  // these boards bake the city into the TITLE — so the location token alone
  // matched every co-located role (a cinematographer pulled ~10 Datadog SWE/sales
  // jobs). Pass the candidate's own location tokens so the matcher excludes them:
  // location is a filter, not relevance. The dedicated scrapers (LinkedIn) and
  // server-side keyword APIs (USAJobs/Dice) take location as a real param, so
  // they're intentionally NOT geo-stripped.
  const geoTerms = buildGeoTermSet(profileLocations);

  const apiTasks = [
    { sourceId: 'linkedin',       fn: (s) => fetchLinkedInJobs(firstQuery, s, days) },
    { sourceId: 'greenhouse',     fn: (s) => fetchGreenhouseJobs(firstQuery, s, geoTerms) },
    { sourceId: 'lever',          fn: (s) => fetchLeverJobs(firstQuery, s, geoTerms) },
    { sourceId: 'usajobs',        fn: (s) => fetchUSAJobs(firstQuery, apiKey, email, s, days) },
    { sourceId: 'remoteok',       fn: (s) => fetchRemoteOKJobs(firstQuery, s, geoTerms) },
    { sourceId: 'weworkremotely', fn: (s) => fetchWeWorkRemotelyJobs(firstQuery, s, geoTerms) },
    { sourceId: 'dice',           fn: (s) => fetchDiceListings(firstQuery, '', s) },
  ];

  // Notify frontend that API sources are starting
  for (const { sourceId } of apiTasks) {
    if (!sender.isDestroyed()) {
      sender.send('job-source-progress', { nodeId, sourceId, status: 'searching', count: 0 });
    }
  }

  return Promise.all(apiTasks.map(async ({ sourceId, fn }) => {
    try {
      if (signal?.aborted) throw new Error('Aborted');
      // Each API fetcher now returns { items, warning } so blocks/throttles
      // can surface in the UI instead of silently producing an empty array.
      const result = await fn(signal);
      const jobs = Array.isArray(result) ? result : (result?.items || []);
      const warning = Array.isArray(result) ? null : (result?.warning || null);
      return { sourceId, jobs, warning };
    } catch (error) {
      return { sourceId, jobs: [], error: error?.message || String(error) };
    }
  }));
}

/**
 * Register all Jobs IPC handlers.
 */
export function registerJobsHandlers() {
  handleSafe('parse-resume', async (event, { filePath, nodeId }, signal) => {
    logger.info(`[Jobs][${nodeId}] Parsing resume:`, filePath);
    const profile = await callLLMDocument(filePath, `
Analyze this resume/CV thoroughly. Return a JSON object with:
{
  "titles": ["exact job titles held, most recent first"],
  "skills": ["all technical and professional skills mentioned"],
  "experience_years": number (total years of professional experience),
  "soft_skills": ["leadership, mentoring, communication examples found"],
  "industries": ["industries worked in"],
  "locations": ["cities/states/countries mentioned or implied"],
  "education": ["degrees, certifications, notable training"],
  "summary": "A 2-sentence professional summary of this person"
}
Extract everything you can find. Be thorough.`, { signal, task: 'resume-parse', responseSchema: RESUME_PARSE_SCHEMA });

    logger.info(`[Jobs][${nodeId}] Resume parsed:`, profile.titles?.join(', '));
    return { profile };
  });

  handleSafe('generate-job-queries', async (event, { profile, targetRole }, signal) => {
    const role = (targetRole || '').trim();
    const targetBlock = role ? `
TARGET ROLE PRIORITY: The user explicitly wants to pivot into or land the role: ${role}.
This is the top priority — bias query construction toward this role even if their resume doesn't fully align.` : '';
    const targetQueryInstruction = role
      ? `"targetRoleQueries": ["3-5 queries that hunt specifically for '${role}' postings. Include seniority + remoteness variants (e.g. '${role} senior', '${role} remote', '${role} junior') and include the candidate's location in at least one. These are the highest-priority queries."]`
      : `"targetRoleQueries": []`;

    const result = await callLLMText(`
You are a career strategist. Given this professional profile, generate search queries for a job search.${targetBlock}

Profile:
${JSON.stringify(profile)}

Return a JSON object with four arrays of search query strings:

{
  "titleQueries": ["2-3 queries using their exact job titles + location, e.g. 'senior backend engineer denver'"],
  "suggestedRoleQueries": ["3-5 queries for roles they could transition into — adjacent, stretch, and pivot roles they may not have considered. Think creatively: a backend engineer could be an engineering manager, developer advocate, solutions architect, technical PM, etc. Include the location."],
  "skillsOnlyQueries": ["2-3 queries using ONLY their skills and experience level, NO job title at all, e.g. 'python kubernetes 8 years team lead distributed systems'. This is intentionally broad to surface unexpected matches."],
  ${targetQueryInstruction}
}

Be creative with suggestedRoleQueries — think about what career directions their skills unlock that they might not have considered.${role ? ` Always include the literal string ${role} in at least one targetRoleQueries entry, paired with the candidate's location.` : ''}`, { signal, task: 'job-query-generation', responseSchema: JOB_QUERY_GENERATION_SCHEMA });

    return { queries: result };
  });

  // ── Search Jobs (Multi-Source Phase 2) ────────────────────────────────────
  handleSafe('search-jobs', async (event, { queries, nodeId, maxAgeDays, canvasFilePath, profileLocations }, signal) => {
    const ageDays = Math.max(1, Math.floor(maxAgeDays || DEFAULT_MAX_AGE_DAYS));
    logger.info(`[Jobs][${nodeId}] Searching with`, queries.length, `queries across 12 sources (maxAge=${ageDays}d)`);

    const tasks = buildJobTasks(queries, ageDays, profileLocations);

    // Group tasks by source for per-source progress tracking
    const sourceTaskIds = {};
    // First scrape URL per source — sent on completion events so the source
    // card's Solve button has a target to open in the cookie-sharing browser
    // (mirrors marketplace's CompSourceCardNode `progress.url` flow).
    const sourceFirstUrl = {};
    // Map each task id → its 0-based page so the result loop can tally per-page
    // yield (answers "is the 2nd-page widen actually pulling extra jobs?").
    const taskPageById = {};
    for (const t of tasks) {
      if (!sourceTaskIds[t.sourceId]) sourceTaskIds[t.sourceId] = [];
      sourceTaskIds[t.sourceId].push(t.id);
      if (!sourceFirstUrl[t.sourceId]) sourceFirstUrl[t.sourceId] = t.url;
      taskPageById[t.id] = t.page || 0;
    }

    // Notify frontend that sources are starting. Include `url` from the
    // first task per source so the JobSourceCardNode's `progress.url` is
    // populated from event #1 — without this, a captcha that hits mid-scrape
    // delivers its warning event BEFORE the per-source completion loop fires
    // (which is the only path that previously carried url), so the card's
    // Solve button stayed hidden until every other source had finished.
    for (const sourceId of Object.keys(sourceTaskIds)) {
      if (!event.sender.isDestroyed()) {
        event.sender.send('job-source-progress', {
          nodeId, sourceId, status: 'searching', count: 0,
          url: sourceFirstUrl[sourceId] || null,
        });
      }
    }

    const allJobs = [];
    const sourceResults = {};

    // 1. Run Scraper Tasks and API Tasks concurrently
    const [results, apiResults] = await Promise.all([
      scrapeMultiple(tasks, (res) => {
        if (event.sender.isDestroyed()) return;
        const sourceId = res.id.replace(/-\d+$/, '');
        const count = Array.isArray(res.data) ? res.data.length : 0;
        event.sender.send('job-source-progress', {
          nodeId,
          sourceId,
          status: res.success ? 'done' : 'error',
          count,
          // Forward anti-bot warning so the JobSourceCardNode can render
          // the embedded text warning instead of silently showing 0 jobs.
          warning: res.warning || null,
          // Include url here too so the Solve button can render against
          // mid-scrape warnings without waiting for the per-source
          // completion event that fires only after EVERY source finishes.
          url: sourceFirstUrl[sourceId] || null,
        });
      }, signal),
      fetchApiSources(queries, event.sender, signal, nodeId, ageDays, profileLocations)
    ]);

    // Process Scraper Results
    for (const result of results) {
      const sourceId = result.id.replace(/-\d+$/, '');
      if (!sourceResults[sourceId]) sourceResults[sourceId] = { jobs: [], errors: 0, warnings: [], pageCounts: {} };

      // Capture anti-bot warning per source even on success — a "success
      // with 0 items" usually means a soft block returned a skeleton page.
      if (result.warning) {
        sourceResults[sourceId].warnings.push(result.warning);
      }
      if (result.success && Array.isArray(result.data)) {
        const tagged = result.data.map(j => ({ ...j, source: sourceId }));
        sourceResults[sourceId].jobs.push(...tagged);
        allJobs.push(...tagged);
        // Tally raw items by page so the funnel can show whether page 2 added
        // anything. Recorded even when count is 0 (page ran, returned nothing).
        const page = taskPageById[result.id] || 0;
        const pc = sourceResults[sourceId].pageCounts;
        pc[page] = (pc[page] || 0) + tagged.length;
      } else {
        sourceResults[sourceId].errors++;
        logger.warn(`[Jobs] Source ${result.id} failed:`, result.error);
        // Synthesize a warning from the error message so the source card
        // can render a reason instead of a bare "Failed". Without this,
        // a Google 45s timeout (or any scrape error that wasn't anti-bot)
        // ends up on the card as red text saying just "Failed".
        const msg = String(result.error || 'Unknown error');
        const isTimeout = /timed?\s*out|timeout/i.test(msg);
        sourceResults[sourceId].warnings.push({
          code: isTimeout ? 'scrape-timeout' : 'scrape-failed',
          severity: 'block',
          evidence: msg.slice(0, 240),
          suggestion: isTimeout
            ? 'Site was unreachable or too slow within 45s. Often a soft block — try a fresh stealth profile or come back later.'
            : 'Scrape failed before extracting jobs. Check logs for the full stack trace.',
        });
      }
    }

    // Process API Results
    for (const res of apiResults) {
      if (!sourceResults[res.sourceId]) sourceResults[res.sourceId] = { jobs: [], errors: 0, warnings: [] };
      // Each API fetcher now returns { items, warning }; the wrapper above
      // also passes warning through. Capture it so blocks/throttles on
      // API-based sources surface in the same UI panel as scraped sources.
      if (res.warning) {
        sourceResults[res.sourceId].warnings.push(res.warning);
      }
      if (res.jobs.length > 0) {
        const tagged = res.jobs.map(j => ({ ...j, source: res.sourceId }));
        sourceResults[res.sourceId].jobs.push(...tagged);
        allJobs.push(...tagged);
      } else if (res.error) {
        sourceResults[res.sourceId].errors++;
        // Same as scrape path: turn the raw error into a visible warning.
        sourceResults[res.sourceId].warnings.push({
          code: 'api-failed',
          severity: 'block',
          evidence: String(res.error).slice(0, 240),
          suggestion: 'API call failed. Check logs for the full response.',
        });
      }
    }

    // Send per-source completion events — include the strongest warning for
    // that source so the card UI keeps showing it even after the final
    // event lands (otherwise the per-source completion event clobbers the
    // earlier scrape-progress event that carried the warning).
    //
    // Status semantics (was: "0 jobs + 0 errors → idle", which was wrong —
    // a source that ran and got 0 isn't idle, it's done with no results):
    //   - 'done'    → ran successfully (count may be 0)
    //   - 'skipped' → pre-skipped without running (config-missing info warning)
    //   - 'error'   → fetched but every attempt failed (errors > 0 OR every
    //                 attempt produced a block warning and no jobs)
    //   - 'idle'    → reserved for "never got a progress event" (renderer fallback)
    for (const sourceId of ALL_SOURCE_IDS) {
      const data = sourceResults[sourceId] || { jobs: [], errors: 0, warnings: [] };
      // Block > info > throttle > nothing. Block wins for visual urgency;
      // info wins over throttle so a config-missing reason isn't hidden by
      // a soft warning.
      const strongest =
        data.warnings.find(w => w?.severity === 'block') ||
        data.warnings.find(w => w?.severity === 'info')  ||
        data.warnings[0] ||
        null;

      const hadBlock = data.warnings.some(w => w?.severity === 'block');
      const hadInfoSkip = data.warnings.some(w => w?.severity === 'info');
      const allFailed = data.errors > 0 && data.jobs.length === 0;

      let status;
      if (data.jobs.length > 0) status = 'done';
      else if (hadInfoSkip)     status = 'skipped';
      else if (allFailed || hadBlock) status = 'error';
      else                      status = 'done';   // ran cleanly, 0 results

      if (!event.sender.isDestroyed()) {
        event.sender.send('job-source-progress', {
          nodeId,
          sourceId,
          status,
          count: data.jobs.length,
          warning: strongest,
          // Failed scrape URL (browser-pool sources only). Empty for API
          // sources — their Solve button won't render, which is correct
          // since opening a login URL doesn't help an extractor that
          // doesn't share cookies anyway.
          url: sourceFirstUrl[sourceId] || null,
        });
      }
    }

    // Flat per-source warning list returned with the response so the JobHub
    // done state can render a copy-able "Scrape Warnings" panel.
    const scrapeWarnings = [];
    for (const [sourceId, data] of Object.entries(sourceResults)) {
      for (const w of data.warnings || []) {
        scrapeWarnings.push({ sourceId, ...w });
      }
    }

    // Deduplicate by normalized company + title
    const seen = new Set();
    const deduped = allJobs.filter(job => {
      const key = `${(job.title || '').toLowerCase().trim()}|${(job.company || '').toLowerCase().trim()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Drop entries whose `posted` string parses to older than maxAgeDays.
    // Sources without a URL date param rely entirely on this pass; those
    // with a URL param re-apply it as a safety net.
    const ageFiltered = filterJobsByAge(deduped, ageDays);
    const ageDropped = deduped.length - ageFiltered.length;

    // Drop anything we've already shown the user on a previous run.
    let kept = ageFiltered;
    let historyDropped = 0;
    if (canvasFilePath) {
      const history = await loadJobsHistory(canvasFilePath);
      const result = dedupAgainstHistory(ageFiltered, history);
      kept = result.kept;
      historyDropped = result.removed;
    }

    logger.info(
      `[Jobs] ${kept.length} new jobs (raw=${allJobs.length}, dedup=${deduped.length}, ageDropped=${ageDropped}, historyDropped=${historyDropped})`
    );
    // Per-source raw gathered counts (+ strongest warning), for ALL sources so a
    // 0 is visible — answers "was this source silently not gathered?" the way the
    // marketplace funnel does. A 0 WITH a warning is a real miss to investigate; a
    // clean 0 is genuinely-empty / off-category (e.g. a cinematographer on USAJobs).
    const bySource = {};
    for (const sid of ALL_SOURCE_IDS) {
      const data = sourceResults[sid] || { jobs: [], warnings: [] };
      const w = (data.warnings || []).find(x => x?.severity === 'block')
        || (data.warnings || []).find(x => x?.severity === 'info')
        || (data.warnings || [])[0] || null;
      bySource[sid] = { count: data.jobs.length, warning: w ? { code: w.code, severity: w.severity } : null };
      // Per-page raw yield, only for the multi-page browser sources (Indeed,
      // Wellfound) — a single-page source (or an API source) has nothing to show.
      const pc = data.pageCounts || {};
      const pageNums = Object.keys(pc).map(Number).sort((a, b) => a - b);
      if (pageNums.length > 1 || pageNums.some(p => p > 0)) {
        bySource[sid].pages = pageNums.map(p => ({ page: p + 1, count: pc[p] }));
      }
    }
    jobsTelemetry.search = {
      ts: Date.now(),
      queries: queries.length,
      raw: allJobs.length,
      deduped: deduped.length,
      ageDropped,
      historyDropped,
      kept: kept.length,
      bySource,
    };
    // A fresh search starts a new run — drop resolves recorded for a prior run.
    jobsTelemetry.resolves = {};
    return { jobs: kept, sourceResults, scrapeWarnings };
  });

  handleSafe('search-jobs-single-source', async (event, { query, sourceId, maxAgeDays, canvasFilePath, nodeId }, signal) => {
    logger.info(`[Jobs] Background single-source search for ${sourceId} with query "${query}"`);
    const ageDays = Math.max(1, Math.floor(maxAgeDays || DEFAULT_MAX_AGE_DAYS));

    let jobs = [];
    let warning = null;

    if (nodeId && !event.sender.isDestroyed()) {
      event.sender.send('job-source-progress', {
        nodeId,
        sourceId,
        status: 'searching',
        count: 0,
        warning: null,
      });
    }

    if (sourceId === 'usajobs') {
      const { usajobsApiKey: apiKey, usajobsEmail: email } = getJobsSettings();
      if (!apiKey || !email) {
        const synthesizedWarning = {
          code: 'config-missing',
          severity: 'info',
          evidence: 'USAJobs API key + email not set',
          suggestion: 'Get a free key at developer.usajobs.gov, then open Settings → Job Sources and paste the API key + your email to enable this source.',
        };
        if (nodeId && !event.sender.isDestroyed()) {
          event.sender.send('job-source-progress', {
            nodeId,
            sourceId,
            status: 'skipped',
            count: 0,
            warning: synthesizedWarning,
          });
        }
        return {
          success: false,
          warning: synthesizedWarning,
        };
      }

      try {
        const result = await fetchUSAJobs(query, apiKey, email, signal, ageDays);
        jobs = Array.isArray(result) ? result : (result?.items || []);
        warning = Array.isArray(result) ? null : (result?.warning || null);
      } catch (err) {
        logger.error(`[USAJobs] Background fetch failed:`, err);
        const synthWarning = {
          code: 'api-failed',
          severity: 'block',
          evidence: String(err?.message || err),
          suggestion: 'API call failed. Check logs for the full response.',
        };
        if (nodeId && !event.sender.isDestroyed()) {
          event.sender.send('job-source-progress', {
            nodeId,
            sourceId,
            status: 'error',
            count: 0,
            warning: synthWarning,
          });
        }
        return {
          success: false,
          error: err?.message || String(err),
          warning: synthWarning,
        };
      }
    } else {
      return { success: false, error: `Unsupported single source: ${sourceId}` };
    }

    const tagged = jobs.map(j => ({ ...j, source: sourceId }));
    
    const seen = new Set();
    const deduped = tagged.filter(job => {
      const key = `${(job.title || '').toLowerCase().trim()}|${(job.company || '').toLowerCase().trim()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const ageFiltered = filterJobsByAge(deduped, ageDays);
    let kept = ageFiltered;
    if (canvasFilePath) {
      const history = await loadJobsHistory(canvasFilePath);
      const result = dedupAgainstHistory(ageFiltered, history);
      kept = result.kept;
    }

    let status = 'done';
    if (warning && warning.severity === 'block') status = 'error';
    else if (warning && warning.severity === 'info') status = 'skipped';

    if (nodeId && !event.sender.isDestroyed()) {
      event.sender.send('job-source-progress', {
        nodeId,
        sourceId,
        status,
        count: kept.length,
        warning,
      });
    }

    return {
      success: true,
      jobs: kept,
      warning,
    };
  });

  // ── Jobs history (60-day rolling CSV next to the canvas JSON) ─────────────
  handleSafe('append-jobs-history', async (_event, { canvasFilePath, jobs }) => {
    return appendJobsHistory(canvasFilePath, jobs);
  });

  handleSafe('load-jobs-history', async (_event, { canvasFilePath }) => {
    const rows = await loadJobsHistory(canvasFilePath);
    return { rows };
  });

  // ── Score Jobs Against Resume ─────────────────────────────────────────────
  handleSafe('score-jobs', async (event, { jobs, profile, nodeId, targetRole }, signal) => {
    const role = (targetRole || '').trim();
    logger.info(`[Jobs][${nodeId}] Scoring`, jobs.length, 'jobs', role ? `(target: ${role})` : '');

    // Budget cap: a widened gather (extra pages / query variants) can over-fill
    // the quota-bound scorer. Pre-rank to the top JOB_SCORE_CAP FAIRLY across
    // sources so we analyze the best slice of a wider pool at ~flat token cost.
    // The overflow drop is reported (cappedForBudget) so it's never silent.
    const gathered = Array.isArray(jobs) ? jobs : [];
    const toScore = selectTopAcrossSources(gathered, JOB_SCORE_CAP);
    const cappedForBudget = gathered.length - toScore.length;
    if (cappedForBudget > 0) {
      logger.info(`[Jobs][${nodeId}] Pre-rank cap: ${gathered.length} gathered → scoring top ${toScore.length} across sources (${cappedForBudget} lower-priority overflow not scored)`);
    }

    // Batch size derived from the job-scoring token budget (see resultCaps);
    // shrinks automatically if a thinking-heavier model raises per-job cost.
    const BATCH_SIZE = jobScoringBatchSize();
    const scoredJobs = [];
    // Telemetry: a job is a "placeholder" when it was emitted with a default
    // matchScore (50) because its batch's LLM call failed or the response was
    // missing its index — i.e. the job was NOT genuinely analyzed. Tracking
    // this lets the bug report distinguish "15 real scores" from "15 scored,
    // 4 of them filler", which the `Scored N jobs` log line alone hides.
    let placeholderCount = 0;
    let failedBatches = 0;
    let batches = 0;
    const scoringModels = new Set(); // distinct models that served the score batches
    // Trim the per-job payload to what actually drives matching. Drop
    // metadata fields (url, source, posted) the scorer doesn't read; keep
    // title/company/location/salary/snippet. Snippet (JD body) dominates
    // the payload, so this is a small but free saving across all batches.
    const slimBatch = (batch) => batch.map((j, idx) => ({
      index: idx,
      title:    j.title || '',
      company:  j.company || '',
      location: j.location || '',
      salary:   j.salary || '',
      snippet:  j.snippet || '',
    }));

    // Static prefix shared across every batch — passed to callLLMText as
    // `cachedPrefix` so providers that support prefix caching (Claude
    // ephemeral, Gemini 2.5 implicit) bill the prefix once at write rate
    // and at ~0.1x on subsequent batch reads. Order matters: static content
    // (instructions + profile + target rules + output spec) all goes here;
    // the dynamic per-batch job payload goes in the user prompt below.
    const targetBlock = role ? `

TARGET ROLE: The user wants to pivot into / land: ${role}.
For each job, set isTargetRoleMatch=true ONLY if the job is reasonably for the target role ${role} (same role family, adjacent seniority, or a near-equivalent title). Set false for everything else, including strong fits in unrelated directions.
Score target-role jobs by the candidate's chance of GETTING AN INTERVIEW for that role — even when their resume is a partial fit, a meaningful pivot opportunity with score 40-60 is more useful than perfect non-target matches.` : `

NO TARGET ROLE was supplied. Set isTargetRoleMatch=false for every job — the field is unused this run.`;
    const cachedPrefix = `You are a career matching expert. Score each job against this candidate's profile.

CANDIDATE PROFILE:
${JSON.stringify(profile)}${targetBlock}

Return JSON of the form { "scores": [ ... one object per job in the array I send next ... ] }:
{
  "scores": [
    {
      "index": 0,
      "matchScore": 85,
      "reasoning": "1-2 sentences explaining WHY this matches or doesn't. Read between the lines — a startup wanting a 'manager with engineering depth' is a match for an experienced engineer even without management title.",
      "careerDirection": "Engineering | Leadership | Product | DevRel | Consulting | Design | Data | Operations | Teaching | Other",
      "strengthLabel": "strong | exploring | stretch | unexpected",
      "isTargetRoleMatch": ${role ? 'true | false (per the target role rules above)' : 'false (no target role this run)'}
    }
  ]
}

IMPORTANT SCORING RULES:
- matchScore is your HOLISTIC judgment of the candidate's chance of getting an interview — NOT a mechanical formula like (skills matched / skills wanted). Read the JD wording carefully: weigh must-haves more than nice-to-haves; consider seniority signal, growth potential, cultural fit, and how a reviewing recruiter would react.
- Don't just match title-to-title. A startup "manager" role that wants someone who's been in the trenches IS a match for an experienced IC.
- Skills-only matches without title match can still score 70%+ if requirements align.
- Score 85%+ only for genuinely strong matches; 65-84 = good chance of interview; 40-64 = stretch / longshot; <40 = unlikely.
- "unexpected" label is for jobs from the skills-only queries that reveal surprising career paths.
- "stretch" label is for plausible pivots where the candidate's experience only partially aligns.
- Aim for 3-7 distinct careerDirection categories total. Merge small categories.`;

    for (let i = 0; i < toScore.length; i += BATCH_SIZE) {
      // Guard: Check if window was closed between batches
      if (signal?.aborted) break;

      batches++;
      const batch = toScore.slice(i, i + BATCH_SIZE);
      let batchResult;

      const batchMeta = {};
      try {
        batchResult = await callLLMText(`JOBS TO SCORE (array, indexed):
${JSON.stringify(slimBatch(batch))}`, {
          signal,
          task: 'job-scoring',
          hints: { itemCount: batch.length },
          responseSchema: JOB_SCORING_SCHEMA,
          cachedPrefix,
          meta: batchMeta,
        });
        if (batchMeta.model) scoringModels.add(batchMeta.model);
      } catch (err) {
        if (signal?.aborted) throw err;
        logger.warn(`[Jobs] Batch scoring failed:`, err);
        batchResult = null; // Forces string fallback below
      }

      // Accept either the wrapped { scores: [...] } shape (schema-enforced)
      // or a bare array (older response format) so the rollout is robust if a
      // provider ever returns the legacy shape.
      const scores = Array.isArray(batchResult?.scores)
        ? batchResult.scores
        : Array.isArray(batchResult)
          ? batchResult
          : null;
      if (scores) {
        batch.forEach((job, idx) => {
          const matched = scores.find(s => s.index === idx);
          if (!matched) placeholderCount++; // index missing from an otherwise-OK batch
          const score = matched || { matchScore: UNSCORED_FALLBACK_SCORE, reasoning: 'Unable to score', careerDirection: 'Other', strengthLabel: 'exploring', isTargetRoleMatch: false };
          scoredJobs.push({ ...job, ...score, isTargetRoleMatch: !!score.isTargetRoleMatch });
        });
      } else {
        logger.warn(`[Jobs] batchResult missing scores array:`, batchResult);
        failedBatches++;
        placeholderCount += batch.length; // whole batch fell back to filler scores
        batch.forEach((job) => {
          scoredJobs.push({ ...job, matchScore: UNSCORED_FALLBACK_SCORE, reasoning: 'AI format error', careerDirection: 'Other', strengthLabel: 'exploring', isTargetRoleMatch: false });
        });
      }
    }

    // Sort by score descending
    scoredJobs.sort((a, b) => b.matchScore - a.matchScore);

    // Group by career direction
    const clusters = {};
    for (const job of scoredJobs) {
      const dir = job.careerDirection || 'Other';
      if (!clusters[dir]) clusters[dir] = [];
      clusters[dir].push(job);
    }

    logger.info(`[Jobs] Scored ${scoredJobs.length} jobs across ${Object.keys(clusters).length} career directions`);
    jobsTelemetry.scoring = {
      ts: Date.now(),
      input: gathered.length,            // jobs the renderer handed us (post gather/dedup/age/history)
      selectedForScoring: toScore.length, // after the across-source budget cap
      cappedForBudget,                    // gathered − selected: by-design overflow, NOT a failure
      scored: scoredJobs.length,
      placeholders: placeholderCount,
      batches,
      failedBatches,
      // >0 means the abort signal cut the batch loop short, so these SELECTED jobs
      // were never sent to the scorer (distinct from cappedForBudget, which were
      // intentionally not selected, and placeholders, which were sent but unusable).
      unscored: toScore.length - scoredJobs.length,
      // Distinct model(s) that served the score batches — usually one, but the
      // fallback chain can shift mid-run if a model starts 429ing between batches.
      models: [...scoringModels],
    };

    return { scoredJobs, clusters };
  });

  // ── Generate Cover Letter ─────────────────────────────────────────────────
  handleSafe('generate-cover-letter', async (event, { profile, job }, signal) => {
    const result = await callLLMText(`
Write a compelling cover letter for this candidate applying to this job.

CANDIDATE:
${JSON.stringify(profile, null, 2)}

JOB:
Title: ${job.title}
Company: ${job.company}
Description: ${job.snippet || 'Not available'}

Return a JSON object:
{
  "coverLetter": "The full cover letter text, properly formatted with paragraphs. Professional but authentic tone. Highlight specific skills that match the job. Keep it concise — 3-4 paragraphs max."
}

Don't be generic. Reference specific skills from the resume that match specific requirements from the job.`, { signal, task: 'cover-letter-generation' });

    return { coverLetter: result.coverLetter };
  });

  // ── Generate Interview Prep ───────────────────────────────────────────────
  handleSafe('generate-interview-prep', async (event, { profile, job }, signal) => {
    logger.info(`[Jobs] Generating interview prep for ${job.title} at ${job.company}`);
    const result = await callLLMText(`
You are an expert career coach preparing a candidate for a job interview.

CANDIDATE PROFILE:
${JSON.stringify(profile, null, 2)}

JOB:
Title: ${job.title}
Company: ${job.company}
Description: ${job.snippet || 'Not available'}

Generate a focused interview prep guide. Return a JSON object:
{
  "questions": [
    {
      "type": "behavioral" | "technical" | "company",
      "question": "The interview question they are likely to be asked",
      "tip": "1-2 sentence coaching tip: what to emphasize from their specific background, which skills to highlight, or what angle to take. Be specific to THIS candidate's profile."
    }
  ]
}

Rules:
- 3 behavioral questions (STAR-format questions about past experience)
- 3 technical/skills questions specific to the role's requirements
- 2 company-specific questions (about the company's mission, product, or growth stage)
- Tips must reference the candidate's ACTUAL skills and experience, not generic advice
- Total: exactly 8 questions`, { signal, task: 'interview-prep-generation', responseSchema: INTERVIEW_PREP_SCHEMA });

    return { questions: result.questions || [] };
  });

  // ── Bucket scored jobs into per-category salary ranges ────────────────────
  // Runs after score-jobs. Takes the scored jobs (which already carry
  // careerDirection) and asks the AI to pick salary bucket boundaries that
  // fit each category's distribution. Returns the bucket tree the renderer
  // uses to spawn the collapsible JobCategoryNode / JobBucketNode hierarchy.
  handleSafe('bucket-jobs', async (event, { jobs, nodeId }, signal) => {
    logger.info(`[Jobs][${nodeId}] Bucketing ${jobs.length} jobs into category/salary tree`);
    // Strip the scored jobs down to just what bucketing needs — careerDirection,
    // salary text, title, index. Drops the reasoning + resumeProfile + snippet
    // payload that would otherwise bloat the prompt and burn tokens on data
    // the bucketer doesn't need.
    const compact = jobs.map((j, i) => ({
      index: i,
      careerDirection: j.careerDirection || 'Other',
      title: j.title || '',
      salary: j.salary || '',
    }));
    const bucketMeta = {}; // populated with the model that actually served this call
    const result = await callLLMText(`
You are a career data analyst. Group these scored jobs by careerDirection, then within each category pick salary bucket boundaries that fit the actual salary distribution.

JOBS:
${JSON.stringify(compact, null, 2)}

Return a JSON object of the shape:
{
  "categories": [
    {
      "name": "Engineering",
      "buckets": [
        { "label": "$60-80k",   "minSalary": 60000, "maxSalary": 80000,  "jobIndices": [0, 4, 7] },
        { "label": "$80-120k",  "minSalary": 80000, "maxSalary": 120000, "jobIndices": [2, 9] },
        { "label": "Unspecified", "minSalary": 0,   "maxSalary": 0,      "jobIndices": [11, 13] }
      ]
    }
  ]
}

RULES:
- Use the EXACT careerDirection values from the input as category names. Don't rename or merge.
- Pick 1–4 buckets per category based on the spread of actual salaries in that category. A category with 2 jobs gets 1 bucket; a category with wide spread gets 3–4.
- Bucket labels should be human-friendly currency ranges: "$60-80k", "$120k+", "Unspecified".
- "$X+" (open-ended top bucket) uses minSalary=X, maxSalary=0.
- Jobs without parseable salary go in a single "Unspecified" bucket per category (minSalary=0, maxSalary=0).
- Every input job MUST appear in exactly one bucket — jobIndices across all buckets must be the complete 0..N-1 set with no duplicates.
- Order buckets from lowest to highest salary; Unspecified last.
- Order categories alphabetically.`, {
      signal,
      task: 'job-bucketing',
      hints: { itemCount: jobs.length },
      responseSchema: JOB_BUCKETING_SCHEMA,
      meta: bucketMeta,
    });
    logger.info(`[Jobs][${nodeId}] Bucketed into ${result?.categories?.length || 0} categories`);
    jobsTelemetry.bucketing = {
      ts: Date.now(),
      input: jobs.length,
      categories: result?.categories?.length || 0,
      model: bucketMeta.model || null,
    };
    return { categories: result?.categories || [] };
  });

  // ── Resolve a job-source block — opens the failed scrape URL in a visible,
  // cookie-sharing browser so the user can solve a captcha or log in. Same
  // underlying primitive marketplace uses for `resolve-captcha`. When the
  // user's session cleared the bot challenge, we run the source's extractor
  // in THAT same visible window so the items the user just unlocked land
  // straight in pendingJobs — without this, "solve captcha" produced 0 jobs
  // from that source because the original headless scrape had already
  // failed, and we'd have needed a full Re-run Search to retry it.
  //
  // Returns { resolved, items } so the renderer can merge items into
  // pendingJobs and drop the warning. items is [] when no extractor is
  // available for the source (API sources can't be inline-extracted; their
  // Solve button doesn't render).
  handleSafe('resolve-job-source', async (event, { url, sourceId, nodeId, canvasFilePath, maxAgeDays } = {}, signal) => {
    if (!url) throw new Error('resolve-job-source requires a url');
    logger.info(`[Jobs][${nodeId}] User opening resolve window for ${sourceId}: ${url}`);
    // Map sourceId → the same extractor JS used by buildJobTasks. Only the
    // scrape sources (those needing Puppeteer) have an extractor here;
    // API sources don't expose a Solve button so this lookup never miss-
    // fires for them.
    const SOURCE_EXTRACTORS = {
      google:       GOOGLE_JOBS_EXTRACTOR,
      indeed:       INDEED_JOBS_EXTRACTOR,
      ziprecruiter: ZIPRECRUITER_EXTRACTOR,
      glassdoor:    GLASSDOOR_EXTRACTOR,
      wellfound:    WELLFOUND_EXTRACTOR,
    };
    const inlineExtractorJS = SOURCE_EXTRACTORS[sourceId] || null;
    const result = await openCaptchaResolveWindow(url, event.sender, signal, inlineExtractorJS);
    const extracted = Array.isArray(result?.items) ? result.items.map(j => ({ ...j, source: sourceId })) : [];

    // Run the SAME age + history dedup the headless search path applies.
    // Without it, this path returned raw items, so every job the user already
    // saw on a prior run re-appeared (and got re-scored) each time they
    // re-solved a source's captcha — the "I keep seeing the same 15 Indeed
    // jobs" report. Indeed is the acute case: it's permanently captcha-walled,
    // so the headless scrape contributes 0 Indeed jobs and they ONLY arrive
    // here — meaning history suppression never touched them at all.
    const ageDays = Math.max(1, Math.floor(maxAgeDays || DEFAULT_MAX_AGE_DAYS));
    const ageFiltered = filterJobsByAge(extracted, ageDays);
    const ageDropped = extracted.length - ageFiltered.length;
    let items = ageFiltered;
    let historyDropped = 0;
    if (canvasFilePath) {
      const history = await loadJobsHistory(canvasFilePath);
      const deduped = dedupAgainstHistory(ageFiltered, history);
      items = deduped.kept;
      historyDropped = deduped.removed;
    }

    logger.info(
      `[Jobs][${nodeId}] Resolve window closed for ${sourceId}; auto-detected=${result.resolved}; ` +
      `inline-extracted=${extracted.length}, ageDropped=${ageDropped}, historyDropped=${historyDropped}, new=${items.length}`
    );
    // Keyed by sourceId so a multi-source recovery keeps every resolve;
    // re-resolving the same source replaces its entry (latest wins).
    jobsTelemetry.resolves[sourceId] = {
      ts: Date.now(),
      extracted: extracted.length,
      ageDropped,
      historyDropped,
      kept: items.length,
    };
    return { resolved: !!result.resolved, items };
  });
}
