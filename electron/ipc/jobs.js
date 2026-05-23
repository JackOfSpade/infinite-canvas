/**
 * Jobs IPC handlers — resume parsing, multi-source job search, AI scoring.
 * 12 Sources: Google, Indeed, LinkedIn, RemoteOK, WeWorkRemotely,
 *             ZipRecruiter, Glassdoor, Dice, Wellfound,
 *             Greenhouse API, Lever API, USAJobs API
 */
import { callLLMDocument, callLLMText } from './llm.js';
import { JOB_SCORING_SCHEMA, JOB_BUCKETING_SCHEMA, RESUME_PARSE_SCHEMA, JOB_QUERY_GENERATION_SCHEMA, INTERVIEW_PREP_SCHEMA, PASTED_JOB_PARSE_SCHEMA } from './aiSchemas.js';
import electronPkg from 'electron';
import { handleSafe } from './ipcUtils.js';
import { scrapeMultiple } from './browserPool.js';
import { openCaptchaResolveWindow } from './browser/authWindows.js';
import { jobScoringBatchSize, HEAVY_WAF_QUERY_CAP, DEFAULT_QUERY_CAP, JOB_SCORE_CAP, JOB_MAX_PAGES } from './resultCaps.js';
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
import { filterJobsByAge, parsePostedDate } from './jobDateFilter.js';
import { getJobsSettings } from './settings.js';
import { readStatusCache } from './accounts.js';

const { ipcMain } = electronPkg;
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
  // The hub node that produced this run. Stamped by every stage handler so the
  // bug report can flag when the funnel belongs to a node that ISN'T in the
  // canvas the report was generated from — this object is a main-process
  // singleton shared by every open window/canvas, so without it a job search in
  // one canvas leaks into another canvas's report.
  nodeId:    null,
  search:    null, // { ts, queries, raw, deduped, ageDropped, historyDropped, kept }
  resolves:  {},   // { [sourceId]: { ts, extracted, ageDropped, historyDropped, kept } }
                   // keyed so a multi-source recovery (e.g. Indeed then LinkedIn)
                   // keeps every resolve; re-resolving a source replaces its
                   // entry. Reset when a fresh search stamps so it's scoped to it.
  scoring:   null, // { ts, input, scored, placeholders, batches, failedBatches, unscored }
  bucketing: null, // { ts, input, categories, placed, missing, duplicated, model, error } — error set when the bucket call threw (flat-spawn fallback)
  pastedPastes: [], // [{ ts, sourceId, chars, parsed, error }] — all manual paste→parse calls this run (Google fallback); array so multiple pastes (first mid-run, second after hub re-blocks) are all visible
  // Per-source job-source-progress event trail for the current search, captured
  // in the main process so it survives the source-card nodes being deleted (the
  // renderer Event History shows WHEN a card was removed, but not the status/
  // warning sequence that drove it). Answers "why did a blocked source's resolve
  // card disappear before the user could act?" — e.g. did it ever emit a clean
  // 'done' that auto-dismissed it. { [sourceId]: [{ t, status, code, severity }] }
  sourceEvents:     {},
  sourceEventsT0:   0, // search-start epoch; event `t` is relative ms from here
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

// Human "reading" pause between page turns within a paginating source's
// session (min/max ms, jittered in the browser pool). Speed is intentionally
// sacrificed for a natural cadence — see JOB_MAX_PAGES.
const PAGE_DELAY_MS = [6000, 14000];

// Synthesize a visible warning from a raw scrape error so a failed source can
// render its reason + a Solve button the INSTANT it fails — not only after the
// whole run finishes. Shared by the per-task progress event and the per-source
// completion loop so a timed-out source isn't left "failed but unflagged" for
// the (now much longer, deep-paginating) duration of the run — the window in
// which its resolve card could be mistaken for an idle/clean card and dismissed.
function synthScrapeWarning(errorMsg) {
  const msg = String(errorMsg || 'Unknown error');
  const isTimeout = /timed?\s*out|timeout/i.test(msg);
  return {
    code: isTimeout ? 'scrape-timeout' : 'scrape-failed',
    severity: 'block',
    evidence: msg.slice(0, 240),
    suggestion: isTimeout
      ? 'Site was unreachable or too slow within the budget. Often a soft block — try a fresh stealth profile or come back later.'
      : 'Scrape failed before extracting jobs. Check logs for the full stack trace.',
  };
}

// Per-source pagination stop callback for executeScrapePaginated. We walk the
// FULL page ceiling (JOB_MAX_PAGES) on every source — the only early stop is a
// genuinely EMPTY page, which is terminal and lossless (no results exist past an
// empty offset, so paging further can only add empty requests). The old
// date-cutoff and duplicate-page (seen-set) stops were removed deliberately: the
// server-side date filter (fromage / days / fromAge / f_TPR) already bounds the
// window, and the seen-set heuristic could false-positive under relevance sort
// (a reshuffled page reads as all-seen) and prune real jobs from deeper pages.
// Any clamped/repeated rows are removed downstream by the cross-source dedup.
// The browser pool independently stops on a hard block / the ceiling.
function makeEmptyPageStop() {
  return ({ items }) => {
    const arr = Array.isArray(items) ? items : [];
    if (arr.length === 0) return { stop: true, reason: 'empty-page' };
    return { stop: false };
  };
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
  // `maxPages` = the hard ceiling on how deep we page (same stealth session) for
  // each query variant. We walk the FULL ceiling page by page, stopping only on a
  // genuinely empty page (makeEmptyPageStop), an anti-bot block, or the ceiling.
  // `urlFn(q, page)` builds the 0-based page URL. Sources that DATE-FILTER
  // server-side (Indeed fromage / Glassdoor fromAge / ZipRecruiter days) won't
  // serve out-of-window rows, so the walk gathers the in-window set; recency is
  // handled by that filter + the client age-filter, not by sorting, and we leave
  // each on its default RELEVANCE sort (no sort param) so the walk keeps the
  // most-relevant in-window jobs — consistent with the relevance-sorted API
  // sources. We do NOT short-circuit on repeated pages: a wrong page-param guess
  // that re-serves page 1 just yields duplicates, which the cross-source dedup
  // removes downstream (cheaper than a seen-set stop that can false-positive
  // under relevance sort and prune real jobs from deeper pages).
  // Google's embedded jobs widget can't be URL-paginated, so it stays 1 page.
  const extractors = {
    google:          { extractor: GOOGLE_JOBS_EXTRACTOR,  config: GOOGLE_JOBS_CONFIG,  maxPages: 1,
                       urlFn: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}&ibp=htl;jobs&htichips=date_posted:${gChip}` },
    indeed:          { extractor: INDEED_JOBS_EXTRACTOR,  config: INDEED_CONFIG,       maxPages: JOB_MAX_PAGES,
                       urlFn: (q, page) => `https://www.indeed.com/jobs?q=${encodeURIComponent(q)}&fromage=${days}${page > 0 ? `&start=${page * 10}` : ''}` },
    ziprecruiter:    { extractor: ZIPRECRUITER_EXTRACTOR, config: ZIPRECRUITER_CONFIG, maxPages: JOB_MAX_PAGES,
                       urlFn: (q, page) => `https://www.ziprecruiter.com/jobs-search${page > 0 ? `/${page + 1}` : ''}?search=${encodeURIComponent(q)}&days=${days}` },
    // Glassdoor migrated to Next.js with infinite-scroll "Show more" pagination —
    // the old ?p=N URL param is silently ignored (every "page" returns page 1).
    // One URL load + JOB_MAX_PAGES-1 button clicks replaces the old N-page walk.
    glassdoor:       { extractor: GLASSDOOR_EXTRACTOR,    config: GLASSDOOR_CONFIG,    maxPages: JOB_MAX_PAGES,
                       urlFn: (q) => `https://www.glassdoor.com/Job/jobs.htm?sc.keyword=${encodeURIComponent(q)}&fromAge=${days}`,
                       loadMoreSelector: '[data-test="load-more"]' },
    wellfound:       { extractor: WELLFOUND_EXTRACTOR,    config: WELLFOUND_CONFIG,    maxPages: JOB_MAX_PAGES,
                       urlFn: (q, page) => `https://wellfound.com/role/${roleSlug(q)}${page > 0 ? `?page=${page + 1}` : ''}` },
  };

  const tasks = [];
  // Remote-only boards get fewer queries; heavy WAF sites get only the first query.
  for (const [sourceId, { extractor, config, urlFn, maxPages = 1, loadMoreSelector = null }] of Object.entries(extractors)) {
    const isHeavyWAF = sourceId === 'ziprecruiter' || sourceId === 'glassdoor';
    const querySubset = isHeavyWAF ? queries.slice(0, HEAVY_WAF_QUERY_CAP) : queries.slice(0, DEFAULT_QUERY_CAP);

    // One task per query. `id` stays `${sourceId}-${n}` so `res.id.replace(/-\d+$/,'')`
    // still maps a result back to its source. A multi-page source runs as a SINGLE
    // paginating task (same-session walk inside the browser pool); a single-page
    // source (Google) runs as a one-shot scrape.
    let idx = 0;
    for (const q of querySubset) {
      const base = { id: `${sourceId}-${idx++}`, sourceId, url: urlFn(q, 0), extractorJS: extractor };
      if (maxPages > 1) {
        base.options = {
          ...config,
          paginate: true,
          maxPages,
          nextUrl: (page) => urlFn(q, page),
          onPageScraped: makeEmptyPageStop(),
          pageDelayMs: PAGE_DELAY_MS,
          ...(loadMoreSelector ? { loadMoreSelector } : {}),
        };
      } else {
        base.options = config;
      }
      tasks.push(base);
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
    { sourceId: 'dice',           fn: (s) => fetchDiceListings(firstQuery, '', s, days) },
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
      // Pre-cap match count: when it exceeds `jobs.length` the fetcher's
      // JOB_RESULT_CAP slice dropped in-window jobs — surfaced in the funnel so an
      // over-the-cap API source isn't a silent miss (mirrors the browser ceiling).
      const gathered = Array.isArray(result) ? jobs.length : (result?.gathered ?? jobs.length);
      return { sourceId, jobs, warning, gathered };
    } catch (error) {
      return { sourceId, jobs: [], error: error?.message || String(error) };
    }
  }));
}

// ── Manual-paste chunking (Google fallback) ──────────────────────────────────
// A large Google-Jobs paste produces more JSON+thinking than the parse-pasted-jobs
// token cap can hold (and the global HARD_CAP is a deliberate cost/latency ceiling
// we don't raise for one feature). So we split the paste into chunks that each fit
// comfortably under the cap, parse them independently, and merge. ~8000 chars/chunk
// keeps each call's cap (2500 + chars/200·400 ≈ 18.5k at 8k) well under HARD_CAP.
const PASTE_CHUNK_CHARS = 8000;

// Split on line boundaries (a Google job entry spans a few consecutive lines),
// packing lines into chunks ≤ maxChars. A single over-long line is hard-split.
// A job that straddles a boundary is recovered by the cross-chunk dedup downstream.
function chunkPastedText(text, maxChars) {
  if (text.length <= maxChars) return [text];
  const chunks = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if (cur && cur.length + line.length + 1 > maxChars) { chunks.push(cur); cur = ''; }
    cur = cur ? `${cur}\n${line}` : line;
    while (cur.length > maxChars) { chunks.push(cur.slice(0, maxChars)); cur = cur.slice(maxChars); }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

// Parse ONE chunk of pasted job text → array of raw { title, company, location,
// salary, snippet }. Throws on truncation / parse failure; the caller decides
// whether one bad chunk should sink the whole submit.
async function parsePastedChunk(chunk, signal) {
  const result = await callLLMText(`
You are parsing job listings a user copied as plain VISIBLE TEXT (not HTML) from a Google Jobs results page. Extract each DISTINCT job posting you can identify.

Rules:
- title is required — skip any entry without a discernible job title.
- company / location / salary / snippet: fill if clearly present, else "".
- Do NOT invent jobs or fields. Only extract what is actually in the text.
- De-duplicate obvious repeats (the same title+company listed twice).

Return JSON: { "jobs": [ { "title", "company", "location", "salary", "snippet" } ] }

PASTED TEXT:
${chunk}`, {
    signal,
    task: 'parse-pasted-jobs',
    hints: { itemCount: Math.max(1, Math.round(chunk.length / 200)) },
    responseSchema: PASTED_JOB_PARSE_SCHEMA,
  });
  return Array.isArray(result?.jobs) ? result.jobs : [];
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

  // ── Parse pasted job text → structured jobs (manual fallback) ──────────────
  // For sources whose results we can't scrape (Google sunset its jobs widget to
  // the JS-rendered, obfuscated udm=8 layout), the user opens the site, copies
  // the visible job text, and pastes it into the source card. We LLM-parse it
  // into the same job shape every other source produces, then it flows through
  // the existing job-source-resolved → merge → score → bucket → spawn path.
  // No reliable direct URL survives a copy-paste, so each job gets a Google Jobs
  // *search* link (udm=8) for its title/company so the card's link button still
  // lands the user on the listing instead of a dead href.
  handleSafe('parse-pasted-jobs', async (event, { text, sourceId, nodeId } = {}, signal) => {
    const raw = String(text || '').trim();
    if (!raw) return { jobs: [] };
    const src = sourceId || 'google';
    const chunks = chunkPastedText(raw, PASTE_CHUNK_CHARS);
    logger.info(`[Jobs][${nodeId}] Parsing pasted ${src} text (${raw.length} chars, ${chunks.length} chunk(s))`);
    // Record the attempt (success / partial / failure) so the bug-report funnel
    // shows the manual-paste step instead of leaving it inferable only from the
    // token-budget truncation marker.
    const stamp = (parsed, error) => {
      jobsTelemetry.nodeId = nodeId;
      jobsTelemetry.windowId = event.sender?.id ?? null;
      jobsTelemetry.pastedPastes.push({ ts: Date.now(), sourceId: src, chars: raw.length, chunks: chunks.length, parsed, error: error || null });
    };

    // Parse chunks SEQUENTIALLY — the Gemini free tier is rate-limited, so
    // concurrent calls just trigger more 429s. A failed chunk is recorded but
    // doesn't sink the rest: partial success beats losing every job to one chunk.
    const rawJobs = [];
    let failedChunks = 0;
    for (let i = 0; i < chunks.length; i++) {
      if (signal?.aborted) break;
      try {
        rawJobs.push(...await parsePastedChunk(chunks[i], signal));
      } catch (err) {
        failedChunks++;
        logger.warn(`[Jobs][${nodeId}] Pasted-job chunk ${i + 1}/${chunks.length} failed: ${err?.message || err}`);
      }
    }

    // Dedup across chunks by title|company (a boundary-split job can land in two
    // chunks), then synthesize the Google Jobs search link per job (a paste can't
    // carry a reliable direct URL — the card's "open" button lands the user on
    // Google Jobs pre-searched for this role).
    const seen = new Set();
    const items = rawJobs
      .filter(j => j && String(j.title || '').trim())
      .filter(j => {
        const k = `${String(j.title).toLowerCase().trim()}|${String(j.company || '').toLowerCase().trim()}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .map(j => {
        const title = String(j.title).trim();
        const company = String(j.company || '').trim();
        const location = String(j.location || '').trim();
        const term = [title, company, location].filter(Boolean).join(' ');
        const url = `https://www.google.com/search?q=${encodeURIComponent(term)}&udm=8`;
        return {
          title, company, location,
          salary: String(j.salary || '').trim(),
          snippet: String(j.snippet || '').trim(),
          url,
          source: src,
        };
      });

    // Error semantics: nothing parsed at all → hard fail (card keeps itself);
    // some chunks failed but we still got jobs → partial-success note (card keeps
    // itself AND the jobs are merged, so missing ones can be re-pasted).
    let error = null;
    if (items.length === 0) {
      error = failedChunks > 0
        ? `Parsing failed on all ${chunks.length} chunk(s) — likely the AI quota is exhausted or the text was unparseable.`
        : 'No jobs found in the pasted text.';
    } else if (failedChunks > 0) {
      error = `Parsed ${items.length} job(s), but ${failedChunks} of ${chunks.length} chunk(s) failed — some jobs may be missing. Re-paste the missing section if needed.`;
    }
    logger.info(`[Jobs][${nodeId}] Parsed ${items.length} job(s) from pasted ${src} text (${chunks.length} chunk(s), ${failedChunks} failed)`);
    stamp(items.length, error);
    return { jobs: items, error };
  });

  // ── Search Jobs (Multi-Source Phase 2) ────────────────────────────────────
  handleSafe('search-jobs', async (event, { queries, nodeId, maxAgeDays, canvasFilePath, profileLocations }, signal) => {
    // Gate: require fresh verified login for all browser-scraped job platforms.
    // These sources return only 1 page when anonymous; login is required for
    // multi-page results. Block early so the user gets a clear message rather
    // than silently getting 5-job results from every browser source.
    const cache = await readStatusCache();
    const BROWSER_JOB_PLATFORMS = ['indeed', 'glassdoor', 'ziprecruiter', 'wellfound'];
    const notLoggedIn = BROWSER_JOB_PLATFORMS.filter(id => !cache[id]?.connected);
    if (notLoggedIn.length > 0) {
      return { success: false, notLoggedIn, error: `Not logged in to: ${notLoggedIn.join(', ')}. Open Settings → Job Platforms to connect.` };
    }

    const ageDays = Math.max(1, Math.floor(maxAgeDays || DEFAULT_MAX_AGE_DAYS));
    logger.info(`[Jobs][${nodeId}] Searching with`, queries.length, `queries across 12 sources (maxAge=${ageDays}d)`);
    jobsTelemetry.nodeId = nodeId;
    jobsTelemetry.windowId = event.sender?.id ?? null;
    // Reset per-run state at search START, not at search end — a paste or captcha
    // resolve can arrive mid-run (before the search result returns), and resetting
    // at the end would wipe those records before the bug report reads them.
    jobsTelemetry.resolves = {};
    jobsTelemetry.pastedPastes = [];
    // Fresh per-source event trail for this run (survives source-card deletion).
    jobsTelemetry.sourceEvents = {};
    jobsTelemetry.sourceEventsT0 = Date.now();
    // Record every job-source-progress we send, then send it. The trail is what
    // lets the bug report explain a "blocked source lost its resolve card" — it
    // shows whether the source ever emitted a clean 'done' (which auto-dismisses
    // the card) vs. only 'error', and how long after a failure the block warning
    // actually landed (the window the card spent failed-but-unflagged).
    const emitProgress = (payload) => {
      if (event.sender.isDestroyed()) return;
      const sid = payload.sourceId;
      const arr = jobsTelemetry.sourceEvents[sid] || (jobsTelemetry.sourceEvents[sid] = []);
      arr.push({
        t: Date.now() - jobsTelemetry.sourceEventsT0,
        status: payload.status,
        code: payload.warning?.code || null,
        severity: payload.warning?.severity || null,
      });
      if (arr.length > 10) arr.shift();
      event.sender.send('job-source-progress', payload);
    };

    const tasks = buildJobTasks(queries, ageDays, profileLocations);

    // Group tasks by source for per-source progress tracking
    const sourceTaskIds = {};
    // First scrape URL per source — sent on completion events so the source
    // card's Solve button has a target to open in the cookie-sharing browser
    // (mirrors marketplace's CompSourceCardNode `progress.url` flow).
    const sourceFirstUrl = {};
    for (const t of tasks) {
      if (!sourceTaskIds[t.sourceId]) sourceTaskIds[t.sourceId] = [];
      sourceTaskIds[t.sourceId].push(t.id);
      if (!sourceFirstUrl[t.sourceId]) sourceFirstUrl[t.sourceId] = t.url;
    }

    // Notify frontend that sources are starting. Include `url` from the
    // first task per source so the JobSourceCardNode's `progress.url` is
    // populated from event #1 — without this, a captcha that hits mid-scrape
    // delivers its warning event BEFORE the per-source completion loop fires
    // (which is the only path that previously carried url), so the card's
    // Solve button stayed hidden until every other source had finished.
    for (const sourceId of Object.keys(sourceTaskIds)) {
      emitProgress({
        nodeId, sourceId, status: 'searching', count: 0,
        url: sourceFirstUrl[sourceId] || null,
      });
    }

    const allJobs = [];
    const sourceResults = {};

    // 1. Run Scraper Tasks and API Tasks concurrently
    const [results, apiResults] = await Promise.all([
      scrapeMultiple(tasks, (res) => {
        const sourceId = res.id.replace(/-\d+$/, '');
        const count = Array.isArray(res.data) ? res.data.length : 0;
        emitProgress({
          nodeId,
          sourceId,
          status: res.success ? 'done' : 'error',
          count,
          // Forward the anti-bot warning; if the task FAILED with no warning
          // (a thrown timeout/nav error carries none), synthesize one NOW so the
          // card shows the reason + Solve immediately and isn't left looking
          // clean/dismissable until the per-source completion loop runs at the
          // end of the (long) run.
          warning: res.warning || (res.success ? null : synthScrapeWarning(res.error)),
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
      if (!sourceResults[sourceId]) sourceResults[sourceId] = { jobs: [], errors: 0, warnings: [], pagesWalked: 0, stopReasons: new Set() };

      // Capture anti-bot warning per source even on success — a "success
      // with 0 items" usually means a soft block returned a skeleton page.
      if (result.warning) {
        sourceResults[sourceId].warnings.push(result.warning);
      }
      if (result.success && Array.isArray(result.data)) {
        const tagged = result.data.map(j => ({ ...j, source: sourceId }));
        sourceResults[sourceId].jobs.push(...tagged);
        allJobs.push(...tagged);
        // How deep the same-session walk went, and why it stopped (paginating
        // sources only; one-shot sources leave pagesWalked at 0). Aggregated
        // across a source's query variants: deepest walk + the set of reasons.
        if (result.pagesWalked != null) {
          sourceResults[sourceId].pagesWalked = Math.max(sourceResults[sourceId].pagesWalked, result.pagesWalked);
          if (result.stopReason) sourceResults[sourceId].stopReasons.add(result.stopReason);
        }
      } else {
        sourceResults[sourceId].errors++;
        logger.warn(`[Jobs] Source ${result.id} failed:`, result.error);
        // Synthesize a warning from the error message so the source card can
        // render a reason instead of a bare "Failed" (same warning the per-task
        // progress event now sends live).
        sourceResults[sourceId].warnings.push(synthScrapeWarning(result.error));
      }
    }

    // Process API Results
    for (const res of apiResults) {
      if (!sourceResults[res.sourceId]) sourceResults[res.sourceId] = { jobs: [], errors: 0, warnings: [] };
      // Pre-cap match count (one fetch per API source). > jobs gathered = the
      // JOB_RESULT_CAP slice dropped in-window jobs the funnel should flag.
      if (res.gathered != null) sourceResults[res.sourceId].gathered = res.gathered;
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

      emitProgress({
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

    // Google Jobs is unscrapeable (the udm=8 widget is JS-rendered and obfuscated),
    // so a clean 0-job result is expected — the user must manually copy/paste.
    // Inject a 'paste' severity warning BEFORE both the scrapeWarnings loop and
    // the bySource build so: (a) the hub's block gate sees it in scrapeWarnings
    // and pauses in 'sources-ready', and (b) the bug-report funnel sees it in
    // bySource.google.warning instead of silently listing Google as "0 results,
    // no warning (genuinely empty)" — which was the misleading pre-fix state.
    const googleData = sourceResults.google;
    if (googleData && googleData.jobs.length === 0 &&
        !googleData.warnings.some(w => w?.severity === 'block')) {
      googleData.warnings.push({
        code: 'paste-needed',
        severity: 'paste',
        evidence: null,
        suggestion: null,
      });
    }

    // Flat per-source warning list returned with the response so the JobHub
    // done state can render a copy-able "Scrape Warnings" panel. Carry each
    // source's scrape `url` so the block gate can re-seed a Solve target if the
    // blocked source's card was lost during the run (see ensureBlockedSourceCards).
    const scrapeWarnings = [];
    for (const [sourceId, data] of Object.entries(sourceResults)) {
      for (const w of data.warnings || []) {
        scrapeWarnings.push({ sourceId, url: sourceFirstUrl[sourceId] || null, ...w });
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
    // Per-source unique survivors of the dedup — lets the funnel tell a genuine
    // page-ceiling ("50 gathered, 50 unique → may be more") apart from a CLAMPING
    // source that re-served the same page across the walk ("50 gathered, 5 unique
    // → not more, the page param is repeating"). The removed duplicate-page stop
    // used to make this call implicitly; now the funnel shows the raw↔unique gap.
    const uniqueBySource = {};
    for (const j of deduped) { const s = j.source || '?'; uniqueBySource[s] = (uniqueBySource[s] || 0) + 1; }

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

    // Newest posted first. Deep pagination gathers across many pages and several
    // sources, so order the pool by recency before it reaches the fair per-source
    // scoring cap (which preserves each source's order) — that way the best slice
    // we score/surface is the most-recent, per the run's intent. Unparseable
    // dates sort last (kept, not dropped); the sort is stable so same-date ties
    // keep gather order (≈ platform relevance).
    const postedMs = (j) => { const d = parsePostedDate(j?.posted); return d ? d.getTime() : -Infinity; };
    kept.sort((a, b) => postedMs(b) - postedMs(a));

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
      bySource[sid] = { count: data.jobs.length, unique: uniqueBySource[sid] || 0, warning: w ? { code: w.code, severity: w.severity } : null };
      // How deep the date-bounded walk went + why it stopped — only for the
      // paginating browser sources (one-shot / API sources leave it unset).
      if (data.pagesWalked > 0) {
        bySource[sid].pagesWalked = data.pagesWalked;
        bySource[sid].stopReason = [...(data.stopReasons || [])].join('/') || null;
      }
      // Pre-cap match count for API sources — the funnel flags when it exceeds
      // `count` (the JOB_RESULT_CAP slice silently dropped in-window jobs).
      if (data.gathered != null) bySource[sid].gathered = data.gathered;
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
    jobsTelemetry.nodeId = nodeId;
    jobsTelemetry.windowId = event.sender?.id ?? null;

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
    jobsTelemetry.nodeId = nodeId;
    jobsTelemetry.windowId = event.sender?.id ?? null;
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
    let result;
    try {
      result = await callLLMText(`
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
    } catch (err) {
      // Bucketing threw (e.g. the Claude streaming-required rejection, an LLM
      // truncation, or a fallback-chain exhaustion). The renderer catches this
      // and falls back to spawning a FLAT job list — no categories. Stamp the
      // funnel with the failure so a bug report distinguishes "bucketing threw"
      // (jobs shown uncategorized, with a recorded reason) from "bucketing never
      // ran this session" (the null slot). Re-throw so handleSafe still returns
      // the error to the renderer for its flat-spawn fallback.
      //
      // An ABORT (user cancelled / deleted the node mid-run) is not a bucketing
      // failure — same distinction handleSafe draws — so don't stamp a spurious
      // "FAILED" for it; just propagate.
      if (!signal?.aborted) {
        jobsTelemetry.bucketing = {
          ts: Date.now(),
          input: jobs.length,
          categories: 0,
          placed: 0,
          missing: jobs.length,
          duplicated: 0,
          model: bucketMeta.model || null,
          error: err?.message || String(err),
        };
      }
      throw err;
    }
    logger.info(`[Jobs][${nodeId}] Bucketed into ${result?.categories?.length || 0} categories`);
    // Verify the bucketer placed EVERY scored job exactly once (the prompt requires
    // jobIndices to be the complete 0..N-1 set). Weak fallback models — common now
    // under quota pressure — can omit or duplicate indices; the renderer's
    // missing-sweep rescues omitted jobs into Uncategorized so they aren't dropped,
    // but the funnel must SHOW when that happened — otherwise the "all jobs
    // accounted for" chain stops at the category count and can't confirm placement.
    const placedCounts = new Map();
    for (const cat of result?.categories || []) {
      for (const buc of cat?.buckets || []) {
        for (const idx of buc?.jobIndices || []) {
          if (Number.isInteger(idx) && idx >= 0 && idx < jobs.length) {
            placedCounts.set(idx, (placedCounts.get(idx) || 0) + 1);
          }
        }
      }
    }
    const placed = placedCounts.size;
    const missing = jobs.length - placed; // omitted by the bucketer → renderer sweeps into Uncategorized
    let duplicated = 0;
    for (const n of placedCounts.values()) if (n > 1) duplicated++;
    // Which indices were omitted — needed to debug "1 missing" without re-running.
    const missingIndices = missing > 0
      ? Array.from({ length: jobs.length }, (_, i) => i).filter(i => !placedCounts.has(i))
      : [];
    if (missing > 0 || duplicated > 0) {
      logger.warn(`[Jobs][${nodeId}] Bucketing placement gap: ${placed}/${jobs.length} placed, ${missing} missing, ${duplicated} duplicated`);
    }
    jobsTelemetry.bucketing = {
      ts: Date.now(),
      input: jobs.length,
      categories: result?.categories?.length || 0,
      placed,
      missing,
      duplicated,
      // Indices (0-based) of jobs the bucketer omitted — cross-reference against
      // the job titles in the scoring funnel to identify the specific job(s).
      missingIndices,
      model: bucketMeta.model || null,
      error: null,
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
      // Why a 0-extract happened: how the window closed, what the extractor saw,
      // and the page state — so "inline-extracted 0 → new 0" stops being an
      // unexplained dead end in the bug report (see openCaptchaResolveWindow).
      diag: result.diag || null,
    };
    return { resolved: !!result.resolved, items };
  });

  // Renderer calls this after it merges captcha-resolve items into pendingJobs.
  // The IPC-side `resolve-job-source` only knows about history-dedup; the
  // renderer does a replace-and-dedup (drops same-source existing jobs, then
  // deduplicates incoming items against the remainder). Without this update the
  // bug report shows "new: N" from the IPC side, which can overstate the actual
  // contribution when the resolver re-opened the same page as the initial scrape
  // (kept=11 from IPC but pendingJobs 28→28 because 11 replaced 11).
  ipcMain.handle('record-resolve-merge', (_event, { sourceId, replacedExisting, fresh, pendingBefore, pendingAfter } = {}) => {
    if (!sourceId || !jobsTelemetry.resolves[sourceId]) return;
    jobsTelemetry.resolves[sourceId].merge = { replacedExisting, fresh, pendingBefore, pendingAfter };
  });
}
