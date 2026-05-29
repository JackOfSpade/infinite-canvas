/**
 * Jobs IPC handlers — resume parsing, multi-source job search, AI scoring.
 * 9 Sources: Google, Indeed, LinkedIn, RemoteOK, WeWorkRemotely,
 *            ZipRecruiter, Glassdoor, Dice, Wellfound, USAJobs
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { callLLMDocument, callLLMText } from './llm.js';
import { JOB_SCORING_SCHEMA, JOB_BUCKETING_SCHEMA, BUCKETING_PLACEMENT_SCHEMA, RESUME_PARSE_SCHEMA, JOB_QUERY_GENERATION_SCHEMA, INTERVIEW_PREP_SCHEMA } from './aiSchemas.js';
import electronPkg from 'electron';
import { handleSafe } from './ipcUtils.js';
import { clearBrowserSession } from './stealthBrowser.js';
import { scrapeManualSources } from './browser/manualScraper.js';
import { openCaptchaResolveWindow } from './browser/authWindows.js';
import { jobScoringBatchSize, JOB_SCORE_CAP, JOB_MAX_PAGES, MEDIUM_TEST, FULL_TEST } from './resultCaps.js';
import { logger } from '../logger.js';
import {
  ZIPRECRUITER_EXTRACTOR, ZIPRECRUITER_CONFIG,
  GLASSDOOR_EXTRACTOR, GLASSDOOR_CONFIG,
  WELLFOUND_EXTRACTOR, WELLFOUND_CONFIG,
  GOOGLE_JOBS_EXTRACTOR, GOOGLE_JOBS_CONFIG,
} from '../extractors/jobs.js';
import {
  fetchLinkedInJobs,
  fetchUSAJobs,
  fetchRemoteOKJobs,
  fetchWeWorkRemotelyJobs,
  fetchDiceListings,
  enrichDiceDescriptions,
  enrichLinkedInDescriptionsBrowser,
  warmDiceApiKey,
  buildGeoTermSet,
} from '../extractors/apiExtractors.js';
import { fetchIndeedListingsBrowser } from '../extractors/indeedBrowser.js';
import { loadJobsHistory, appendJobsHistory, dedupAgainstHistory } from './jobsHistory.js';
import { filterJobsByAge, parsePostedDate } from './jobDateFilter.js';
import { getJobsSettings } from './settings.js';
import { readStatusCache } from './accounts.js';
import { getScopedJobSourceIds } from '../../src/utils/jobSourceScope.js';
import { dedupeJobsByKey, jobTitleCompanyKey } from '../../src/utils/jobIdentity.js';

const { ipcMain, app } = electronPkg;
const DEFAULT_MAX_AGE_DAYS = 21;
// Sentinel score for jobs the AI couldn't score (missing from the batch result,
// or a whole batch that failed to parse). NOT adaptive: a fixed midpoint marks
// "unscored" rather than asserting a real fit — the bug-report telemetry counts
// these (placeholderCount) so a scoring failure stays visible instead of being
// laundered into a plausible number.
const UNSCORED_FALLBACK_SCORE = 50;
const JOB_ANALYSIS_SNAPSHOT_VERSION = 1;
const JOB_ANALYSIS_DIR = 'job-search';
const JOB_ANALYSIS_JSON = 'job-search-last-scrape.json';
const JOB_ANALYSIS_PROMPT = 'job-search-scoring-AI-prompt.txt';

async function assertReadableResumeFile(filePath) {
  const displayName = filePath ? path.basename(filePath) : 'Selected item';
  let stats = null;
  try {
    stats = await fs.promises.stat(filePath);
  } catch (err) {
    if (err?.code === 'ENOENT') {
      throw new Error(`${displayName} could not be found. Pick a resume file and try again.`);
    }
    if (err?.code === 'EPERM' || err?.code === 'EACCES') {
      throw new Error(`${displayName} can't be accessed — permission denied. Check the file's permissions, or drop a different resume.`);
    }
    throw err;
  }
  if (!stats.isFile()) {
    if (/\.app$/i.test(displayName)) {
      throw new Error(`${displayName} is a macOS app, not a resume. Drop a PDF, DOCX, TXT, or image of your resume instead.`);
    }
    throw new Error(`${displayName} is a folder or package, not a resume file. Drop a PDF, DOCX, TXT, or image of your resume instead.`);
  }
  try {
    await fs.promises.access(filePath, fs.constants.R_OK);
  } catch {
    throw new Error(`${displayName} exists but can't be read — the file may be locked or have restrictive permissions. Try again, or drop a different resume.`);
  }
  return { displayName, stats };
}

async function computeFileSha256(filePath) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

function getJobAnalysisPaths(canvasFilePath) {
  const dir = canvasFilePath
    ? path.dirname(canvasFilePath)
    : path.join(app.getPath('userData'), JOB_ANALYSIS_DIR);
  return {
    dir,
    jsonPath: path.join(dir, JOB_ANALYSIS_JSON),
    promptPath: path.join(dir, JOB_ANALYSIS_PROMPT),
  };
}

// Writes the exact text sent to the AI: the cached prefix followed by each
// batch payload. Uses previewBatches (all gathered jobs, ignoring score cap)
// so the file is populated even when AI scoring is skipped in test mode.
function formatPromptFile(snapshot) {
  const { createdAt, gatheredJobCount, cachedPrefix, previewBatches } = snapshot;
  const ts = createdAt ? new Date(createdAt).toLocaleString() : '';
  const batches = previewBatches ?? [];
  const sep = '='.repeat(72);

  const lines = [
    `Complete AI scoring prompt — ${ts}`,
    `${gatheredJobCount ?? 0} jobs gathered, ${batches.length} batch${batches.length === 1 ? '' : 'es'}`,
    '',
    sep,
    'CACHED PREFIX  (sent once; reused across every batch via prompt caching)',
    sep,
    '',
    cachedPrefix ?? '',
  ];

  if (batches.length === 0) {
    lines.push('', '(no jobs — scoring was skipped or no jobs were gathered)');
  } else {
    for (const batch of batches) {
      lines.push('', sep, `BATCH ${batch.batchNumber} of ${batches.length}  (${batch.jobCount} jobs)`, sep, '', batch.prompt);
    }
  }

  return lines.join('\n');
}

async function saveJobAnalysisSnapshot(snapshot) {
  const { dir, jsonPath, promptPath } = getJobAnalysisPaths(snapshot.canvasFilePath);
  if (!snapshot.canvasFilePath) await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(jsonPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  await fs.promises.writeFile(promptPath, formatPromptFile(snapshot), 'utf8');
  return { jsonPath, promptPath };
}

async function loadJobAnalysisSnapshot(canvasFilePath) {
  const { jsonPath, promptPath } = getJobAnalysisPaths(canvasFilePath);
  const raw = await fs.promises.readFile(jsonPath, 'utf8');
  const parsed = JSON.parse(raw);
  return {
    snapshot: parsed,
    paths: { jsonPath, promptPath },
  };
}

function buildJobAnalysisSnapshot({ jobs, profile, nodeId, targetRole, snapshotContext }) {
  const role = (targetRole || '').trim();
  const gathered = Array.isArray(jobs) ? jobs : [];
  const toScore = selectTopAcrossSources(gathered, JOB_SCORE_CAP);
  const cappedForBudget = gathered.length - toScore.length;
  const batchSize = jobScoringBatchSize();
  const slimBatch = (batch) => batch.map((j, idx) => ({
    index: idx,
    title:    j.title || '',
    company:  j.company || '',
    location: j.location || '',
    salary:   j.salary || '',
    snippet:  j.snippet || '',
  }));

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

  const scoringBatchPayloads = [];
  for (let i = 0; i < toScore.length; i += batchSize) {
    const batch = toScore.slice(i, i + batchSize);
    scoringBatchPayloads.push({
      batchNumber: Math.floor(i / batchSize) + 1,
      jobCount: batch.length,
      jobs: slimBatch(batch),
    });
  }

  // Preview batches use ALL gathered jobs (ignoring score cap) so the prompt
  // file is populated even when scoring is skipped in test mode.
  const previewBatchPayloads = [];
  for (let i = 0; i < gathered.length; i += batchSize) {
    const batch = gathered.slice(i, i + batchSize);
    previewBatchPayloads.push({
      batchNumber: Math.floor(i / batchSize) + 1,
      jobCount: batch.length,
      jobs: slimBatch(batch),
    });
  }

  return {
    role,
    gathered,
    toScore,
    cappedForBudget,
    batchSize,
    slimBatch,
    cachedPrefix,
    snapshot: {
      version: JOB_ANALYSIS_SNAPSHOT_VERSION,
      createdAt: new Date().toISOString(),
      nodeId: nodeId || null,
      sourceHubId: snapshotContext?.sourceHubId || nodeId || null,
      canvasFilePath: snapshotContext?.canvasFilePath || null,
      resumeSummary: snapshotContext?.resumeSummary || '',
      targetRole: role,
      gatheredJobCount: gathered.length,
      selectedJobCount: toScore.length,
      cappedForBudget,
      jobScoreCap: JOB_SCORE_CAP,
      batchSize,
      profile,
      jobs: gathered,
      selectedJobs: toScore,
      cachedPrefix,
      batches: scoringBatchPayloads.map((batch) => ({
        ...batch,
        prompt: `JOBS TO SCORE (array, indexed):\n${JSON.stringify(batch.jobs)}`,
      })),
      previewBatches: previewBatchPayloads.map((batch) => ({
        ...batch,
        prompt: `JOBS TO SCORE (array, indexed):\n${JSON.stringify(batch.jobs)}`,
      })),
    },
  };
}

// ── Pipeline telemetry ───────────────────────────────────────────────────────
// Records the last job-search funnel so the bug reporter can answer "did we
// analyze all the jobs we found?" without depending on (a) the renderer node
// tree, which vanishes the instant the user deletes the hub, or (b) the 60-line
// log ring buffer, which scrolls. Each stage stamps its own slot independently
// because the stages are separate IPC calls that don't always run together
// (e.g. a captcha-resolve scores pendingJobs with no fresh search). Mirrors
// gemini.js's getGeminiTelemetry().

// Best-effort egress (public) IP lookup. Used to verify a VPN switch actually
// changed the IP before retrying LinkedIn enrichment — the guest rate-limit is
// per-IP, so retrying on the same warm IP just walls instantly. Returns null on
// any failure so callers degrade gracefully (proceed without the guard).
async function getEgressIp() {
  let timer = null;
  try {
    const ctrl = new AbortController();
    timer = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch('https://api.ipify.org?format=json', { signal: ctrl.signal });
    if (!res.ok) return null;
    const data = await res.json();
    return (data && typeof data.ip === 'string') ? data.ip : null;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// The egress IP at which LinkedIn last hit its per-IP guest ceiling. Set when a
// re-fetch walls; checked on the next retry — if the IP hasn't changed, the user
// hasn't switched their VPN yet, so we prompt instead of wasting a pass on the
// same warm IP. Cleared when enrichment completes without hitting the ceiling.
// Process-scoped (resets on app restart), which is fine — a warm IP cools anyway.
let linkedinLastCeilingIp = null;

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
  // Per-source job-source-progress event trail for the current search, captured
  // in the main process so it survives the source-card nodes being deleted (the
  // renderer Event History shows WHEN a card was removed, but not the status/
  // warning sequence that drove it). Answers "why did a blocked source's resolve
  // card disappear before the user could act?" — e.g. did it ever emit a clean
  // 'done' that auto-dismissed it. { [sourceId]: [{ t, status, code, severity }] }
  sourceEvents:     {},
  sourceEventsT0:   0, // search-start epoch; event `t` is relative ms from here
  // LinkedIn anonymous-enrichment pass trail: the initial search's enrichment
  // pass plus every Solve re-fetch, newest-last, capped. The guest description
  // limit is per-IP, so "switch your VPN and Solve again" only helps if the
  // egress IP actually changes — and that is the ONE variable the rest of the
  // report is blind to. Recording the IP (and whether the lookup even worked)
  // per pass is what lets a checkup distinguish "IP never changed / lookup
  // failing → same-IP guard is dead" from "IP changed but every shared VPN exit
  // is pre-warmed → switching can't help". { ts, kind, ip, ipOk, walled,
  // skippedSameIp, enriched, stillEmpty, contextRotations }
  linkedinEnrich:   [],
};

export function getJobsTelemetry() {
  return jobsTelemetry;
}

// Append one LinkedIn enrichment-pass record to the capped trail (see
// jobsTelemetry.linkedinEnrich). ipOk distinguishes "ran on IP x" from "egress
// lookup returned null" — the latter means the same-IP VPN guard can't function.
function recordLinkedinEnrichPass(entry) {
  jobsTelemetry.linkedinEnrich.push({ ts: Date.now(), ...entry });
  // Keep the last dozen — enough to see the cross-Solve IP trend across a test
  // session without unbounded growth.
  if (jobsTelemetry.linkedinEnrich.length > 12) jobsTelemetry.linkedinEnrich.shift();
}

// All source IDs — defines the complete set for progress tracking and reporting.
const ALL_SOURCE_IDS = [
  'google', 'indeed', 'linkedin', 'remoteok', 'weworkremotely',
  'ziprecruiter', 'glassdoor', 'dice', 'wellfound',
  'usajobs',
];
const ACTIVE_SOURCE_IDS = getScopedJobSourceIds(ALL_SOURCE_IDS);
const ACTIVE_SOURCE_ID_SET = new Set(ACTIVE_SOURCE_IDS);

function getQueryProgressTotal(queries) {
  return Math.max(1, Array.isArray(queries) ? queries.filter(Boolean).length : 1);
}

function getCompletedQueriesFromDetail(detail, total) {
  const match = String(detail || '').match(/\bq(\d+)\/(\d+)\b/i);
  if (!match) return 0;
  const currentQuery = Number.parseInt(match[1], 10);
  const detailTotal = Number.parseInt(match[2], 10);
  const effectiveTotal = Number.isFinite(detailTotal) && detailTotal > 0 ? detailTotal : total;
  return Math.max(0, Math.min(effectiveTotal, currentQuery - 1));
}

// Sources that moved from browser pool to direct API:
// - indeed: Scrapfly REST API with ASP, cache, and a cost budget (no local browser).
// - remoteok: Open JSON API at remoteok.com/api (zero WAF)
// - weworkremotely: RSS feed at weworkremotely.com/remote-jobs.rss (zero WAF)

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
  if (/SITE_CHANGED/i.test(msg)) {
    return {
      code: 'stale-selectors',
      severity: 'warn',
      evidence: msg.slice(0, 240),
      suggestion: 'Extractor returned 0 results — the site HTML may have changed. Update the scraper code in electron/extractors/jobs.js, rebuild, and retry.',
    };
  }
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

function getEffectiveSourceWarning(warning, jobCount) {
  if (!warning) return null;
  // A timeout on one query variant after other variants already returned jobs is
  // a partial scrape miss, not a source-level block that should masquerade as
  // an unresolved captcha/login problem. Keep the evidence, but downgrade the
  // severity for terminal status + source-card presentation.
  if (jobCount > 0 && warning.code === 'scrape-timeout' && warning.severity === 'block') {
    return { ...warning, severity: 'warn' };
  }
  return warning;
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
function getLocationTerms(profileLocations = [], preferredLocation = '') {
  const terms = Array.isArray(profileLocations) ? [...profileLocations] : [];
  if (preferredLocation) terms.push(preferredLocation);
  return terms;
}

function buildJobTasks(queries, maxAgeDays, profileLocations = [], preferredLocation = '') {
  const days = Math.max(1, Math.floor(maxAgeDays || DEFAULT_MAX_AGE_DAYS));
  // Wellfound is the one browser source whose URL is a /role/{slug} SEO page, not
  // a free-text search box. The query carries the candidate's city ("Cinematographer
  // Denver"), and slugging the whole thing produced "/role/cinematographer-denver"
  // — not a real role slug, so the page returned nothing and we logged a misleading
  // "genuinely empty" 0. Same principle as the board-source geo fix: strip the
  // candidate's own location tokens from the role identifier (location is a filter,
  // not part of the role). The location-aware search sources (Indeed/Glassdoor/Zip/
  // Google) keep the city below — they WANT it as a query term.
  const geoTerms = buildGeoTermSet(getLocationTerms(profileLocations, preferredLocation));
  const roleSlug = (q) => String(q).toLowerCase().split(/\s+/)
    .filter(tok => tok && !geoTerms.has(tok.replace(/[^a-z0-9]/g, '')))
    .join('-');
  // Browser pool extractors — only platforms that REQUIRE local browser rendering.
  // Indeed, RemoteOK, and WeWorkRemotely have been moved to fetchApiSources.
  //
  // `maxPages` = the hard ceiling on how deep we page (same stealth session) for
  // each query variant. We walk the FULL ceiling page by page, stopping only on a
  // genuinely empty page (makeEmptyPageStop), an anti-bot block, or the ceiling.
  // `urlFn(q, page)` builds the 0-based page URL. Sources that DATE-FILTER
  // server-side (Glassdoor fromAge / ZipRecruiter days) won't serve out-of-window
  // rows, so the walk gathers the in-window set; recency is handled by that filter
  // + the client age-filter, not by sorting, and we leave each on its default
  // RELEVANCE sort (no sort param) so the walk keeps the most-relevant in-window
  // jobs — consistent with the relevance-sorted API sources. We do NOT short-
  // circuit on repeated pages: a wrong page-param guess that re-serves page 1 just
  // yields duplicates, which the cross-source dedup removes downstream (cheaper
  // than a seen-set stop that can false-positive under relevance sort and prune
  // real jobs from deeper pages).
  const extractors = {
    // Google Jobs: single-page scroll-loaded panel (ibp=htl;jobs). No pagination —
    // scroll logic is handled by SCROLL_SOURCES in manualScraper.js. Does not throw
    // SITE_CHANGED on 0 (bot detection can block the panel entirely).
    google:          { extractor: GOOGLE_JOBS_EXTRACTOR,  config: GOOGLE_JOBS_CONFIG,  maxPages: 1,
                       urlFn: (q) => `https://www.google.com/search?q=${encodeURIComponent(q + ' jobs')}&ibp=htl;jobs` },
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
  for (const [sourceId, { extractor, config, urlFn, maxPages = 1, loadMoreSelector = null }] of Object.entries(extractors)) {
    if (!ACTIVE_SOURCE_ID_SET.has(sourceId)) continue;
    const querySubset = queries;

    // One task per query. `id` stays `${sourceId}-${n}` so `res.id.replace(/-\d+$/,'')`
    // still maps a result back to its source. A multi-page source runs as a SINGLE
    // paginating task (same-session walk inside the browser pool); a single-page
    // source (Google) runs as a one-shot scrape.
    let idx = 0;
    for (const q of querySubset) {
      const base = { id: `${sourceId}-${idx++}`, sourceId, url: urlFn(q, 0), extractorJS: extractor, query: q };
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
function dedupByTitleCompany(arr) {
  return dedupeJobsByKey(arr, jobTitleCompanyKey);
}

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
// Fan-out a single-query fetcher across all queries, merge and deduplicate by
// title+company. Returns the same { items, warning } shape.
//
// `concurrency`    — max simultaneous in-flight fetcher calls (default: unbounded).
// `minIntervalMs`  — minimum ms between consecutive dispatch times, shared across
//                    all workers. Prevents request bursts that trigger per-key
//                    rate limits (e.g. Dice returns 500 when several queries fire
//                    within the same second). JS is single-threaded between awaits,
//                    so reading + bumping `nextSlotTime` is atomic — no two workers
//                    can claim the same slot.
async function queryFanOut(queries, fetcher, signal, concurrency = Infinity, minIntervalMs = 0) {
  let results;
  if (!isFinite(concurrency) || concurrency >= queries.length) {
    // Fast path — all concurrent (original behaviour for most sources)
    results = await Promise.all(
      queries.map(q => fetcher(q, signal).catch(() => ({ items: [] })))
    );
  } else {
    results = new Array(queries.length);
    let next = 0;
    // Shared dispatch clock: each worker atomically claims the next available
    // slot, then waits until that slot time before firing its request.
    let nextSlotTime = minIntervalMs > 0 ? Date.now() : 0;
    async function worker() {
      while (next < queries.length) {
        const idx = next++;
        if (minIntervalMs > 0) {
          // Claim the next slot. `Math.max` handles the case where a worker
          // re-enters after a long retry — it doesn't skip ahead of a slot
          // already claimed by another worker, but it also doesn't stall
          // behind a slot that's already in the past.
          const slotTime = Math.max(Date.now(), nextSlotTime);
          nextSlotTime = slotTime + minIntervalMs;
          const waitMs = slotTime - Date.now();
          if (waitMs > 0) await new Promise(res => setTimeout(res, waitMs));
        }
        results[idx] = await fetcher(queries[idx], signal).catch(() => ({ items: [] }));
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, queries.length) }, worker));
  }
  const items = dedupeJobsByKey(
    results.flatMap(r => r?.items || []),
    jobTitleCompanyKey,
  );
  const warning = [...results].reverse().find(r => r?.warning)?.warning ?? null;
  return { items, warning };
}

async function fetchApiSources(queries, sender, signal = null, nodeId = null, maxAgeDays = DEFAULT_MAX_AGE_DAYS, profileLocations = [], preferredLocation = '') {
  // Source credentials come from Settings (electron-store) with a legacy
  // process.env fallback handled inside getJobsSettings() for users still
  // on the old .env config.
  const { usajobsApiKey: apiKey, usajobsEmail: email } = getJobsSettings();
  const days = Math.max(1, Math.floor(maxAgeDays || DEFAULT_MAX_AGE_DAYS));
  const location = String(preferredLocation || '').trim();
  const queryTotal = getQueryProgressTotal(queries);

  // Keyword-less company-board / remote-feed sources keyword-filter client-side
  // against the query. The query carries the candidate's city ("… Denver"), and
  // these boards bake the city into the TITLE — so the location token alone
  // matched every co-located role (a cinematographer pulled ~10 Datadog SWE/sales
  // jobs). Pass the candidate's own location tokens so the matcher excludes them:
  // location is a filter, not relevance. The dedicated scrapers (LinkedIn) and
  // server-side keyword APIs (USAJobs/Dice) take location as a real param, so
  // they're intentionally NOT geo-stripped.
  const geoTerms = buildGeoTermSet(getLocationTerms(profileLocations, preferredLocation));

  const apiTasks = [
    { sourceId: 'indeed',        fn: (s) => fetchIndeedListingsBrowser(queries, s, days, null, (detail) => {
      if (sender && !sender.isDestroyed()) {
        sender.send('job-source-progress', {
          nodeId,
          sourceId: 'indeed',
          status: 'searching',
          count: 0,
          detail,
          completed: getCompletedQueriesFromDetail(detail, queryTotal),
          total: queryTotal,
        });
      }
    }) },
    { sourceId: 'linkedin',      fn: (s) => fetchLinkedInJobs(queries, s, days) },
    { sourceId: 'usajobs',       fn: (s) => queryFanOut(queries, (q, sig) => fetchUSAJobs(q, apiKey, email, sig, days, location), s) },
    { sourceId: 'remoteok',      fn: (s) => fetchRemoteOKJobs(queries, s, geoTerms) },
    { sourceId: 'weworkremotely',fn: (s) => fetchWeWorkRemotelyJobs(queries, s, geoTerms) },
    { sourceId: 'dice',          fn: async (s) => {
      // Pre-warm the key before fan-out so all queries use a fresh key.
      // Dice rate-limits by request rate (not just concurrency): firing several
      // requests within the same second triggers 500 even with a fresh key.
      // minIntervalMs=350 spaces queries ~350ms apart (12 queries ≈ 4s total),
      // keeping each request well within the per-key burst window.
      // Enrichment (detail fetch) is deferred to after history dedup so we
      // only fetch descriptions for jobs that will actually be scored/shown.
      await warmDiceApiKey();
      logger.info(`[Dice API] Fan-out starting: ${queries.length} queries, 350ms interval`);
      return queryFanOut(queries, (q, sig) => fetchDiceListings(q, location, sig, days), s, 4, 350);
    }},
  ].filter(task => ACTIVE_SOURCE_ID_SET.has(task.sourceId));

  // Notify frontend that API sources are starting
  for (const { sourceId } of apiTasks) {
    if (!sender.isDestroyed()) {
      sender.send('job-source-progress', { nodeId, sourceId, status: 'searching', count: 0, completed: 0, total: queryTotal });
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
      // Emit live completion so the source card updates as soon as this source
      // finishes — without this, all API cards stay "Searching..." until the
      // browser scraper finishes too (the final per-source loop runs post-Promise.all).
      if (sender && !sender.isDestroyed()) {
        sender.send('job-source-progress', {
          nodeId,
          sourceId,
          status: warning?.severity === 'block' ? 'error' : 'done',
          count: jobs.length,
          warning: warning || null,
          completed: queryTotal,
          total: queryTotal,
        });
      }
      return { sourceId, jobs, warning, gathered };
    } catch (error) {
      if (sender && !sender.isDestroyed()) {
        sender.send('job-source-progress', { nodeId, sourceId, status: 'error', count: 0, completed: queryTotal, total: queryTotal });
      }
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
    await assertReadableResumeFile(filePath);
    const fingerprint = await computeFileSha256(filePath);
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
    return { profile, fingerprint };
  });

  handleSafe('get-resume-fingerprint', async (event, { filePath }) => {
    const { stats } = await assertReadableResumeFile(filePath);
    const fingerprint = await computeFileSha256(filePath);
    return {
      fingerprint,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
    };
  });

  handleSafe('generate-job-queries', async (event, { profile, targetRole, preferredLocation }, signal) => {
    const role = (targetRole || '').trim();
    const location = String(preferredLocation || '').trim();
    const targetBlock = role ? `
TARGET ROLE PRIORITY: The user explicitly wants to pivot into or land the role: ${role}.
This is the top priority — bias query construction toward this role even if their resume doesn't fully align.` : '';
    const locationBlock = location ? `
PREFERRED SEARCH LOCATION: ${location}
Use this as search context. It is free-form user input and may be a city, state, region, "remote", "hybrid in Chicago", "Midwest", etc. Interpret it naturally.
Only include it in queries when it improves the search. Do NOT force it into every query.` : `
No preferred search location was provided. Do NOT add location terms to queries by default.`;
    const targetQueryInstruction = role
      ? `"targetRoleQueries": ["3-5 queries that hunt specifically for '${role}' postings. Include seniority + remoteness variants (e.g. '${role} senior', '${role} remote', '${role} junior'). If a preferred search location was provided, you may include it in 1-2 entries where it improves precision. These are the highest-priority queries."]`
      : `"targetRoleQueries": []`;

    const queryMeta = {};
    const result = await callLLMText(`
You are a career strategist. Given this professional profile, generate search queries for a job search.${targetBlock}${locationBlock}

Profile:
${JSON.stringify(profile)}

Return a JSON object with four arrays of search query strings:

{
  "titleQueries": ["2-3 queries using their exact job titles. Do not include location unless a preferred search location was explicitly provided and it clearly helps."],
  "suggestedRoleQueries": ["3-5 queries for roles they could transition into — adjacent, stretch, and pivot roles they may not have considered. Think creatively: a backend engineer could be an engineering manager, developer advocate, solutions architect, technical PM, etc. Do not include location unless a preferred search location was explicitly provided and it clearly helps."],
  "skillsOnlyQueries": ["2-3 queries using ONLY their skills and experience level, NO job title at all, e.g. 'python kubernetes 8 years team lead distributed systems'. This is intentionally broad to surface unexpected matches."],
  ${targetQueryInstruction}
}

Be creative with suggestedRoleQueries — think about what career directions their skills unlock that they might not have considered.${role ? ` Always include the literal string ${role} in at least one targetRoleQueries entry.` : ''}`, { signal, task: 'job-query-generation', responseSchema: JOB_QUERY_GENERATION_SCHEMA, meta: queryMeta });

    return { queries: result, queryModel: queryMeta.model || null };
  });

  handleSafe('get-last-job-analysis-snapshot', async (event, { canvasFilePath } = {}) => {
    try {
      const { snapshot, paths } = await loadJobAnalysisSnapshot(canvasFilePath);
      const jobs = Array.isArray(snapshot?.jobs) ? snapshot.jobs : [];
      const profile = snapshot?.profile && typeof snapshot.profile === 'object' ? snapshot.profile : null;
      return {
        exists: true,
        snapshot: {
          ...snapshot,
          jobs,
          profile,
        },
        meta: {
          version: snapshot?.version ?? null,
          createdAt: snapshot?.createdAt ?? null,
          targetRole: snapshot?.targetRole ?? '',
          gatheredJobCount: snapshot?.gatheredJobCount ?? jobs.length,
          selectedJobCount: snapshot?.selectedJobCount ?? jobs.length,
          sourceHubId: snapshot?.sourceHubId ?? snapshot?.nodeId ?? null,
          canvasFilePath: snapshot?.canvasFilePath ?? null,
          resumeSummary: snapshot?.resumeSummary ?? '',
          promptPath: paths.promptPath,
          jsonPath: paths.jsonPath,
        },
      };
    } catch (err) {
      if (err?.code === 'ENOENT') return { exists: false };
      throw err;
    }
  });

  handleSafe('save-job-analysis-snapshot', async (event, { jobs, profile, nodeId, targetRole, snapshotContext } = {}) => {
    const { snapshot } = buildJobAnalysisSnapshot({ jobs, profile, nodeId, targetRole, snapshotContext });
    const paths = await saveJobAnalysisSnapshot(snapshot);
    logger.info(`[Jobs][${nodeId}] Saved AI prompt snapshot to ${paths.jsonPath}`);
    return {
      saved: true,
      meta: {
        version: snapshot.version,
        createdAt: snapshot.createdAt,
        targetRole: snapshot.targetRole,
        gatheredJobCount: snapshot.gatheredJobCount,
        selectedJobCount: snapshot.selectedJobCount,
        promptPath: paths.mdPath,
        jsonPath: paths.jsonPath,
      },
    };
  });

  // ── Search Jobs (Multi-Source Phase 2) ────────────────────────────────────
  handleSafe('search-jobs', async (event, { queries, nodeId, maxAgeDays, canvasFilePath, profileLocations, preferredLocation }, signal) => {
    if (ACTIVE_SOURCE_IDS.length === 0) {
      return { success: false, error: 'No active job sources configured for job search test mode.' };
    }

    // Gate: require verified login for all browser-scraped job platforms.
    const BROWSER_JOB_PLATFORMS = getScopedJobSourceIds(['indeed', 'glassdoor', 'ziprecruiter', 'wellfound']);
    const cache = await readStatusCache();
    const notLoggedIn = BROWSER_JOB_PLATFORMS.filter(id => !cache[id]?.connected);
    if (notLoggedIn.length > 0) {
      return { success: false, notLoggedIn, error: `Not logged in to: ${notLoggedIn.join(', ')}. Open Settings → Job Platforms to connect.` };
    }

    const ageDays = Math.max(1, Math.floor(maxAgeDays || DEFAULT_MAX_AGE_DAYS));
    logger.info(`[Jobs][${nodeId}] Searching with`, queries.length, `queries across ${ACTIVE_SOURCE_IDS.length} source(s) (maxAge=${ageDays}d)`);
    jobsTelemetry.nodeId = nodeId;
    jobsTelemetry.windowId = event.sender?.id ?? null;
    // Reset per-run state at search START, not at search end — a paste or captcha
    // resolve can arrive mid-run (before the search result returns), and resetting
    // at the end would wipe those records before the bug report reads them.
    jobsTelemetry.resolves = {};
    jobsTelemetry.sourceBlockedUrls = {}; // sourceId → [url, ...] for multi-query sequential solve
    // Fresh per-source event trail for this run (survives source-card deletion).
    jobsTelemetry.sourceEvents = {};
    jobsTelemetry.sourceEventsT0 = Date.now();
    jobsTelemetry.linkedinEnrich = []; // fresh egress-IP trail per run (see definition)
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

    const tasks = buildJobTasks(queries, ageDays, profileLocations, preferredLocation);

    // Group tasks by source for per-source progress tracking
    const sourceTaskIds = {};
    // First scrape URL per source — sent on completion events so the source
    // card's Solve button has a target to open in the cookie-sharing browser
    // (mirrors marketplace's CompSourceCardNode `progress.url` flow).
    const sourceFirstUrl = {};
    const sourceBlockedUrls = {}; // sourceId → [url, ...] in task order
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
        completed: 0,
        total: sourceTaskIds[sourceId]?.length || 1,
        url: sourceFirstUrl[sourceId] || null,
      });
    }

    const allJobs = [];
    const sourceResults = {};

    // 1. Run browser collection (manual) and API sources concurrently.
    // pipelineAbort allows a future unrecoverable failure to abort both halves.
    // Individual API source failures (e.g. Dice 500) are source-level errors —
    // they return 0 jobs with a warning and do NOT abort the pipeline.
    const pipelineAbort = new AbortController();
    const combinedSignal = AbortSignal.any([pipelineAbort.signal, signal].filter(s => s instanceof AbortSignal));

    const [results, apiResults] = await Promise.all([
      scrapeManualSources(tasks, (res) => {
        const sourceId = res.id.replace(/-\d+$/, '');
        const count = Array.isArray(res.data) ? res.data.length : 0;
        const total = sourceTaskIds[sourceId]?.length || 1;
        const blocked = res.warning?.severity === 'block';
        emitProgress({
          nodeId,
          sourceId,
          status: blocked ? 'error' : 'done',
          count,
          completed: total,
          total,
          warning: res.warning || null,
          url: sourceFirstUrl[sourceId] || null,
        });
      }, combinedSignal),
      fetchApiSources(queries, event.sender, combinedSignal, nodeId, ageDays, profileLocations, preferredLocation),
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

    // Glassdoor behavioral contribution-gate detection. The body-text soft gate in
    // antiBotDetector.js already has the right pattern, but Glassdoor's 775KB HTML
    // buries "To restore your access" far past the HTML_SCAN_CHARS=5000 window, so
    // it never fires during the headless scrape. Behavioral signal is more reliable:
    // a logged-in session that extracts ≤10 jobs then hits an empty "Show more" is
    // almost certainly gated (Glassdoor caps free-account results at ~5), not sparse.
    // Inject a block-severity warning so the card shows a Solve button — the user
    // opens the two-tab resolve window, submits a review/salary in Tab 2, then
    // Tab 1 auto-extracts the full ungated result set.
    const gdData = sourceResults.glassdoor;
    if (gdData && gdData.jobs.length > 0 && gdData.jobs.length <= 10 &&
        gdData.pagesWalked <= 1 &&
        !gdData.warnings.some(w => w?.severity === 'block')) {
      gdData.warnings.push({
        code: 'glassdoor-review-gate',
        severity: 'block',
        evidence: `Glassdoor returned only ${gdData.jobs.length} job(s) before hitting an empty page — consistent with the contribution gate.`,
        openSecondTab: true,
        suggestion: 'Glassdoor is gating results behind a review. Two tabs will open — use Tab 2 to write a company review or add a salary, then switch back to Tab 1 (job results) and refresh it. The full list will be captured and the window will close automatically.',
      });
    }

    // Persist blocked URLs for the resolve handler to use post-search.
    jobsTelemetry.sourceBlockedUrls = sourceBlockedUrls;

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
    for (const sourceId of ACTIVE_SOURCE_IDS) {
      const data = sourceResults[sourceId] || { jobs: [], errors: 0, warnings: [] };
      const progressTotal = sourceTaskIds[sourceId]?.length || getQueryProgressTotal(queries);
      const effectiveWarnings = (data.warnings || []).map(w => getEffectiveSourceWarning(w, data.jobs.length));
      // Block > info > throttle > nothing. Block wins for visual urgency;
      // info wins over throttle so a config-missing reason isn't hidden by
      // a soft warning.
      const strongest =
        effectiveWarnings.find(w => w?.severity === 'block') ||
        effectiveWarnings.find(w => w?.severity === 'info')  ||
        effectiveWarnings[0] ||
        null;

      const hadBlock = effectiveWarnings.some(w => w?.severity === 'block');
      const hadInfoSkip = effectiveWarnings.some(w => w?.severity === 'info');
      const allFailed = data.errors > 0 && data.jobs.length === 0;

      let status;
      if (hadInfoSkip)          status = 'skipped';
      else if (hadBlock)        status = 'error';
      else if (data.jobs.length > 0) status = 'done';
      else if (allFailed)       status = 'error';
      else                      status = 'done';   // ran cleanly, 0 results

      emitProgress({
        nodeId,
        sourceId,
        status,
        count: data.jobs.length,
        completed: progressTotal,
        total: progressTotal,
        warning: strongest,
        // Failed scrape URL (browser-pool sources only). Empty for API
        // sources — their Solve button won't render, which is correct
        // since opening a login URL doesn't help an extractor that
        // doesn't share cookies anyway.
        url: sourceFirstUrl[sourceId] || null,
      });
    }

    // Flat per-source warning list returned with the response so the JobHub
    // done state can render a copy-able "Scrape Warnings" panel. Carry each
    // source's scrape `url` so the block gate can re-seed a Solve target if the
    // blocked source's card was lost during the run (see ensureBlockedSourceCards).
    const scrapeWarnings = [];
    for (const [sourceId, data] of Object.entries(sourceResults)) {
      for (const w of data.warnings || []) {
        const effectiveWarning = getEffectiveSourceWarning(w, data.jobs.length) || w;
        scrapeWarnings.push({
          sourceId,
          url: sourceFirstUrl[sourceId] || null,
          ...effectiveWarning,
        });
      }
    }

    // Deduplicate by normalized company + title
    const deduped = dedupByTitleCompany(allJobs);
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
      logger.info(`[Jobs][${nodeId}] History: ${history.length} entries loaded from ${path.basename(canvasFilePath)}`);
      const result = dedupAgainstHistory(ageFiltered, history);
      kept = result.kept;
      historyDropped = result.removed;
      // Record pre-scoring so test-mode runs and aborted/crashed runs still
      // mark these jobs as seen. appendJobsHistory deduplicates internally,
      // so the renderer-side write after scoring is a safe no-op for these rows.
      appendJobsHistory(canvasFilePath, kept).catch(() => {});
    } else {
      logger.info(`[Jobs][${nodeId}] History: skipped (no canvas path)`);
    }

    // Enrich Dice jobs with full descriptions — runs after all filtering so we
    // only fetch detail pages for jobs that will actually be scored/shown.
    const diceKept = kept.filter(j => j.source === 'dice');
    if (diceKept.length > 0) {
      const enriched = await enrichDiceDescriptions(diceKept, combinedSignal);
      const enrichedByUrl = new Map(enriched.map(j => [j.url, j]));
      kept = kept.map(j => j.source === 'dice' && enrichedByUrl.has(j.url) ? enrichedByUrl.get(j.url) : j);
    }

    // Enrich LinkedIn jobs with full descriptions via the shared stealth browser.
    // Plain fetch() returns HTTP 999; the browser bypasses that wall.
    // One tab is opened on the already-running browser, navigated through each
    // job URL sequentially, then closed. Stops early on a login wall.
    const linkedinKept = kept.filter(j => j.source === 'linkedin');
    if (linkedinKept.length > 0) {
      // Re-enter 'searching' before browser enrichment so the source card stays
      // visible and its dismiss timer is cancelled. Without this, the card gets
      // its 'done' event when the API fetch finishes (10+ min ago), then the
      // 10 s grace fires and the card disappears while the hub is still running.
      emitProgress({ nodeId, sourceId: 'linkedin', status: 'searching', count: linkedinKept.length, detail: 'enriching descriptions', completed: 0, total: 1 });
      const { jobs: enriched, loginWall, successCount: lkSuccess = 0 } = await enrichLinkedInDescriptionsBrowser(linkedinKept, combinedSignal);
      const enrichedByUrl = new Map(enriched.map(j => [j.url, j]));
      kept = kept.map(j => j.source === 'linkedin' && enrichedByUrl.has(j.url) ? enrichedByUrl.get(j.url) : j);

      if (loginWall) {
        // NOT a session/login problem: descriptions are fetched anonymously
        // (cookieless guest JSON-LD), so this is LinkedIn's per-IP guest
        // rate-limit. Capture the warm IP so the next retry can verify a VPN
        // switch actually changed it before re-attempting, and tell the user to
        // switch VPN (a fresh IP resets the per-IP quota) — logging in does nothing.
        linkedinLastCeilingIp = await getEgressIp();
        const stillEmpty = kept.filter(j => j.source === 'linkedin' && (!j.snippet || j.snippet.length < 100)).length;
        const ipNote = linkedinLastCeilingIp ? ` (IP ${linkedinLastCeilingIp})` : '';
        const rateWarning = {
          code: 'linkedin-rate-limited',
          severity: 'throttle', // 'throttle' keeps the Solve button visible (hidden for 'warn'/'info') and renders amber, not block-red
          shortLabel: 'Switch VPN',
          evidence: `LinkedIn's anonymous guest limit stopped enrichment after ${lkSuccess} description(s)${ipNote} — ${stillEmpty} job(s) still without one.`,
          suggestion: 'This IP is rate-limited. Switch your VPN to a new location, then click Solve to fetch the next batch. (Logging in does not help — descriptions are fetched anonymously.)',
        };
        emitProgress({
          nodeId,
          sourceId: 'linkedin',
          count: linkedinKept.length,
          status: 'error',
          url: 'https://www.linkedin.com/jobs',
          warning: rateWarning,
          completed: 1,
          total: 1,
        });
        // Include in scrapeWarnings so the JobHub done-state panel surfaces it too.
        scrapeWarnings.push({ sourceId: 'linkedin', url: null, ...rateWarning });
        // Baseline pass for the egress-IP trail: this is the warm IP every
        // subsequent Solve is trying to escape. ipOk:false here means the lookup
        // itself failed — the same-IP guard then has nothing to compare against.
        recordLinkedinEnrichPass({
          kind: 'search', ip: linkedinLastCeilingIp, ipOk: !!linkedinLastCeilingIp,
          walled: true, enriched: lkSuccess, stillEmpty,
        });
      } else {
        linkedinLastCeilingIp = null; // enrichment finished without the ceiling — reset
        // Emit final done so the card transitions to its terminal state and the
        // dismiss timer restarts (10 s grace after enrichment completes, not after
        // the API fetch).
        emitProgress({ nodeId, sourceId: 'linkedin', count: linkedinKept.length, status: 'done', completed: 1, total: 1 });
        // Clean pass — no wall, so no IP-switch question. Record it (no IP
        // lookup, to avoid paying the ipify round-trip on the happy path).
        recordLinkedinEnrichPass({ kind: 'search', ip: null, ipOk: null, walled: false, enriched: lkSuccess });
      }
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
    // Per-source raw gathered counts (+ strongest warning), for active sources so a
    // 0 is visible — answers "was this source silently not gathered?" the way the
    // marketplace funnel does. A 0 WITH a warning is a real miss to investigate; a
    // clean 0 is genuinely-empty / off-category (e.g. a cinematographer on USAJobs).
    const bySource = {};
    for (const sid of ACTIVE_SOURCE_IDS) {
      const data = sourceResults[sid] || { jobs: [], warnings: [] };
      const w = (data.warnings || []).find(x => x?.severity === 'block')
        || (data.warnings || []).find(x => x?.severity === 'info')
        || (data.warnings || [])[0] || null;
      bySource[sid] = {
        count: data.jobs.length,
        unique: uniqueBySource[sid] || 0,
        warning: w ? {
          code: w.code,
          severity: w.severity,
          evidence: w.evidence ? String(w.evidence).slice(0, 700) : null,
        } : null,
      };
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
    return { jobs: kept, rawCount: allJobs.length, sourceResults, scrapeWarnings };
  });

  handleSafe('search-jobs-single-source', async (event, { query, sourceId, maxAgeDays, canvasFilePath, nodeId, preferredLocation }, signal) => {
    logger.info(`[Jobs] Background single-source search for ${sourceId} with query "${query}"`);
    if (!ACTIVE_SOURCE_ID_SET.has(sourceId)) {
      return {
        success: false,
        disabled: true,
        error: `Job source "${sourceId}" is disabled by the current job search test-mode scope.`,
      };
    }

    const ageDays = Math.max(1, Math.floor(maxAgeDays || DEFAULT_MAX_AGE_DAYS));
    const location = String(preferredLocation || '').trim();

    let jobs = [];
    let warning = null;

    if (nodeId && !event.sender.isDestroyed()) {
      event.sender.send('job-source-progress', {
        nodeId,
        sourceId,
        status: 'searching',
        count: 0,
        warning: null,
        completed: 0,
        total: 1,
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
            completed: 1,
            total: 1,
          });
        }
        return {
          success: false,
          warning: synthesizedWarning,
        };
      }

      try {
        const result = await fetchUSAJobs(query, apiKey, email, signal, ageDays, location);
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
            completed: 1,
            total: 1,
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
    const deduped = dedupByTitleCompany(tagged);

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
        completed: 1,
        total: 1,
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
  handleSafe('score-jobs', async (event, { jobs, profile, nodeId, targetRole, snapshotContext } = {}, signal) => {
    const { role, gathered, toScore, cappedForBudget, batchSize: BATCH_SIZE, slimBatch, cachedPrefix, snapshot } =
      buildJobAnalysisSnapshot({ jobs, profile, nodeId, targetRole, snapshotContext });
    logger.info(`[Jobs][${nodeId}] Scoring`, gathered.length, 'jobs', role ? `(target: ${role})` : '');
    jobsTelemetry.nodeId = nodeId;
    jobsTelemetry.windowId = event.sender?.id ?? null;
    if (cappedForBudget > 0) {
      logger.info(`[Jobs][${nodeId}] Pre-rank cap: ${gathered.length} gathered → scoring top ${toScore.length} across sources (${cappedForBudget} lower-priority overflow not scored)`);
    }

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
    try {
      const paths = await saveJobAnalysisSnapshot(snapshot);
      logger.info(`[Jobs][${nodeId}] Saved AI prompt snapshot to ${paths.jsonPath}`);
    } catch (err) {
      logger.warn(`[Jobs][${nodeId}] Failed to save AI prompt snapshot:`, err);
    }

    for (let i = 0; i < toScore.length; i += BATCH_SIZE) {
      // Guard: Check if window was closed between batches
      if (signal?.aborted) break;

      batches++;
      const batch = toScore.slice(i, i + BATCH_SIZE);
      let batchResult;
      const batchPrompt = `JOBS TO SCORE (array, indexed):
${JSON.stringify(slimBatch(batch))}`;

      const batchMeta = {};
      try {
        batchResult = await callLLMText(batchPrompt, {
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

    return { scoredJobs, clusters, testMode: MEDIUM_TEST || FULL_TEST };
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

    // Targeted retry for any jobs the bucketer dropped. Sends only the missing
    // jobs with a minimal prompt — small input is reliable even on haiku.
    // Mutates result.categories in place so the return value and telemetry both
    // reflect the rescued state.
    if (missing > 0 && !signal?.aborted) {
      const missingCompact = missingIndices.map(i => compact[i]);
      const categoryNames = (result?.categories || []).map(c => c.name).join(', ');
      const retryMeta = {};
      try {
        const retryResult = await callLLMText(
          `A job bucketer omitted ${missing} job(s). Place each in the correct category.\n\nAVAILABLE CATEGORIES: ${categoryNames}\n\nJOBS:\n${JSON.stringify(missingCompact, null, 2)}\n\nEvery job must appear in exactly one placement. Use only the available category names.`,
          { signal, task: 'job-bucketing', responseSchema: BUCKETING_PLACEMENT_SCHEMA, meta: retryMeta },
        );
        for (const p of retryResult?.placements || []) {
          if (!Number.isInteger(p?.index) || p.index < 0 || p.index >= jobs.length) continue;
          const cat = (result.categories || []).find(c => c.name === p.categoryName) ?? result.categories?.[0];
          if (!cat) continue;
          let bucket = cat.buckets.find(b => b.label === 'Unspecified');
          if (!bucket) {
            bucket = { label: 'Unspecified', minSalary: 0, maxSalary: 0, jobIndices: [] };
            cat.buckets.push(bucket);
          }
          if (!bucket.jobIndices.includes(p.index)) bucket.jobIndices.push(p.index);
        }
        logger.info(`[Jobs][${nodeId}] Bucketing retry rescued ${retryResult?.placements?.length || 0} missing job(s) via ${retryMeta.model || 'unknown'}`);
      } catch {
        // Retry failed — renderer's missing-sweep still handles it
      }
    }

    // Recount after any retry so telemetry reflects the final state.
    const finalPlacedCounts = new Map();
    for (const cat of result?.categories || []) {
      for (const buc of cat?.buckets || []) {
        for (const idx of buc?.jobIndices || []) {
          if (Number.isInteger(idx) && idx >= 0 && idx < jobs.length)
            finalPlacedCounts.set(idx, (finalPlacedCounts.get(idx) || 0) + 1);
        }
      }
    }
    const finalPlaced = finalPlacedCounts.size;
    const finalMissing = jobs.length - finalPlaced;
    const finalMissingIndices = finalMissing > 0
      ? Array.from({ length: jobs.length }, (_, i) => i).filter(i => !finalPlacedCounts.has(i))
      : [];

    jobsTelemetry.bucketing = {
      ts: Date.now(),
      input: jobs.length,
      categories: result?.categories?.length || 0,
      placed: finalPlaced,
      missing: finalMissing,
      duplicated,
      missingIndices: finalMissingIndices,
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
  handleSafe('resolve-job-source', async (event, { url, sourceId, nodeId, canvasFilePath, maxAgeDays, secondTabUrl } = {}, signal) => {
    if (!url) throw new Error('resolve-job-source requires a url');
    logger.info(`[Jobs][${nodeId}] User opening resolve window for ${sourceId}: ${url}${secondTabUrl ? ' (2-tab)' : ''}`);

    // LinkedIn "Solve" = re-fetch descriptions, NOT log in. Descriptions come
    // from ANONYMOUS guest pages (the cookieless JSON-LD; the logged-in SPA has
    // none — probe-confirmed), so the user's LinkedIn session is irrelevant to
    // enrichment and the wall is LinkedIn's per-IP guest rate-limit, not an
    // expired login. We therefore do NOT open a login window here — that was the
    // "opens then instantly closes" the user saw: they're already logged in, so
    // /login auto-redirects to /feed and the window self-closes with nothing to
    // do. Solve just re-runs anonymous enrichment, which (via context rotation)
    // fills another batch as LinkedIn's guest quota cools down.
    const isLinkedInReEnrich = sourceId === 'linkedin';
    if (isLinkedInReEnrich) {
      // Resolve-attempt telemetry — the LinkedIn branch returns directly and
      // never reaches the generic resolves[] recorder below, so without this the
      // bug report's "Captcha-resolve / Solve" section is blank for LinkedIn.
      const recordResolve = (extra) => {
        jobsTelemetry.resolves[sourceId] = {
          ts: Date.now(), kind: 'linkedin-reenrich',
          ...(jobsTelemetry.resolves[sourceId]?.kind === 'linkedin-reenrich' ? jobsTelemetry.resolves[sourceId] : {}),
          ...extra,
        };
      };
      const sendProgress = (payload) => event.sender?.send?.('job-source-progress', payload);

      let items = [];
      try {
        const { snapshot } = await loadJobAnalysisSnapshot(canvasFilePath);
        // Guard against a snapshot from a different hub (e.g. user ran hub B
        // after hub A's rate-limit card was left open).
        const snapshotIsThisHub = !snapshot.sourceHubId || snapshot.sourceHubId === nodeId;
        const allLinkedIn = snapshotIsThisHub
          ? (snapshot?.jobs || []).filter(j => j.source === 'linkedin')
          : [];
        const needEnrich = allLinkedIn.filter(j => !j.snippet || j.snippet.length < 100);

        if (needEnrich.length > 0) {
          logger.info(`[Jobs][${nodeId}] LinkedIn re-fetch: ${needEnrich.length}/${allLinkedIn.length} job(s) still without descriptions`);

          // IP-changed guard: the guest rate-limit is per-IP, so retrying on the
          // SAME warm IP just walls instantly. If we previously hit the ceiling
          // and the egress IP hasn't changed, the user hasn't switched their VPN
          // yet — prompt instead of wasting a pass. (Null IP = lookup failed;
          // degrade gracefully and just proceed.)
          const currentIp = await getEgressIp();
          if (linkedinLastCeilingIp && currentIp && currentIp === linkedinLastCeilingIp) {
            const switchWarning = {
              code: 'linkedin-rate-limited', severity: 'throttle', shortLabel: 'Switch VPN',
              evidence: `Still on IP ${currentIp} — the one LinkedIn rate-limited. The VPN switch hasn't taken effect.`,
              suggestion: 'Switch your VPN to a new location (confirm the IP actually changes), then click Solve to continue. Logging in does not help — descriptions are fetched anonymously.',
            };
            recordResolve({ needEnrich: needEnrich.length, enrichSuccess: 0, walled: true, skippedSameIp: true, warmIp: currentIp });
            recordLinkedinEnrichPass({ kind: 'solve', ip: currentIp, ipOk: !!currentIp, walled: false, skippedSameIp: true, enriched: 0 });
            logger.info(`[Jobs][${nodeId}] LinkedIn re-fetch skipped — egress IP unchanged (${currentIp}); prompting VPN switch`);
            sendProgress({ nodeId, sourceId: 'linkedin', count: allLinkedIn.length, status: 'error', url: 'https://www.linkedin.com/jobs', warning: switchWarning });
            return { resolved: true, items: allLinkedIn, warning: switchWarning, replaceSourceItems: true, nextBlockedUrl: null };
          }

          sendProgress({ nodeId, sourceId: 'linkedin', status: 'searching', count: needEnrich.length, detail: 're-fetching descriptions', warning: null });
          const { jobs: enriched, loginWall: walled, successCount = 0, contextRotations = 0 } = await enrichLinkedInDescriptionsBrowser(needEnrich, signal);
          // Merge whatever we got this pass back into the full set (keeps prior
          // descriptions for jobs enriched before the ceiling was hit).
          const enrichedByUrl = new Map(enriched.map(j => [j.url, j]));
          items = allLinkedIn.map(j => enrichedByUrl.get(j.url) || j);
          const stillEmpty = items.filter(j => !j.snippet || j.snippet.length < 100).length;
          recordResolve({ needEnrich: needEnrich.length, enrichSuccess: successCount, contextRotations, walled, stillEmpty });
          // Egress-IP trail entry for this Solve. `walled` distinguishes the
          // re-walled outcome from a clean finish; comparing `ip` to the prior
          // pass's is what answers "did the VPN switch actually change the IP?".
          recordLinkedinEnrichPass({ kind: 'solve', ip: currentIp, ipOk: !!currentIp, walled, enriched: successCount, stillEmpty, contextRotations });
          logger.info(`[Jobs][${nodeId}] LinkedIn re-fetch: +${successCount} description(s), ${stillEmpty} still empty (${contextRotations} ctx-rotation(s)${walled ? ', hit IP ceiling' : ''})`);

          // Persist this pass's descriptions back to the snapshot. Without this,
          // re-fetch always re-reads the SAME stale "N empty" snapshot and re-does
          // the first batch — so a retry hits the warm-IP ceiling earlier and adds
          // nothing new (observed: two retries both read 272 empty, both re-did the
          // first jobs). Re-saving shrinks needEnrich each pass so retries actually
          // walk DEEPER into the list as LinkedIn's guest quota cools.
          if (successCount > 0) {
            try {
              const itemsByUrl = new Map(items.map(j => [j.url, j]));
              const mergedJobs = (snapshot.jobs || []).map(j =>
                j.source === 'linkedin' ? (itemsByUrl.get(j.url) || j) : j);
              await saveJobAnalysisSnapshot({ ...snapshot, jobs: mergedJobs, canvasFilePath });
            } catch (e) {
              logger.warn(`[Jobs][${nodeId}] LinkedIn re-fetch: could not persist descriptions to snapshot — ${e.message}`);
            }
          }

          if (walled && stillEmpty > 0) {
            // Got a batch but hit LinkedIn's per-IP guest ceiling again. Remember
            // THIS IP as warm so the next retry's guard can require a VPN switch.
            // severity 'throttle' (not 'warn') keeps the action button visible (the
            // card hides it for 'warn'/'info') and renders amber rather than
            // block-red. Return resolved:true (so the descriptions we DID get merge
            // in) AND the warning (so the renderer keeps it, not a clean done).
            linkedinLastCeilingIp = currentIp || linkedinLastCeilingIp;
            const ipNote = currentIp ? ` (IP ${currentIp})` : '';
            const rateWarning = {
              code: 'linkedin-rate-limited', severity: 'throttle', shortLabel: 'Switch VPN',
              evidence: `LinkedIn's anonymous guest limit stopped after +${successCount} this pass${ipNote} — ${stillEmpty} job(s) still without a description.`,
              suggestion: 'This IP is now rate-limited. Switch your VPN to a new location, then click Solve to fetch the next batch. Logging in does not help — descriptions are fetched anonymously.',
            };
            sendProgress({ nodeId, sourceId: 'linkedin', count: items.length, status: 'error', url: 'https://www.linkedin.com/jobs', warning: rateWarning });
            return { resolved: true, items, warning: rateWarning, replaceSourceItems: true, nextBlockedUrl: null };
          }
          linkedinLastCeilingIp = null; // finished without hitting the ceiling — reset
          sendProgress({ nodeId, sourceId: 'linkedin', count: items.length, status: 'done' });
          return { resolved: true, items, replaceSourceItems: true, nextBlockedUrl: null };
        } else if (allLinkedIn.length > 0) {
          // Everything already has a description — return them so the hub merge
          // still replaces the pending set (clears the warning cleanly).
          logger.info(`[Jobs][${nodeId}] LinkedIn re-fetch: all ${allLinkedIn.length} jobs already have descriptions`);
          items = allLinkedIn;
          sendProgress({ nodeId, sourceId: 'linkedin', count: allLinkedIn.length, status: 'done' });
          return { resolved: true, items, replaceSourceItems: true, nextBlockedUrl: null };
        } else {
          logger.warn(`[Jobs][${nodeId}] LinkedIn re-fetch: snapshot has no LinkedIn jobs for this hub (sourceHubId=${snapshot.sourceHubId}) — returning empty items`);
        }
      } catch (err) {
        // Snapshot unreadable or malformed — fall through with items: [].
        logger.warn(`[Jobs][${nodeId}] LinkedIn re-fetch skipped — snapshot unavailable: ${err.message}`);
      }

      return { resolved: false, items: [], nextBlockedUrl: null };
    }

    // Map sourceId → the same extractor JS used by buildJobTasks. Only the
    // scrape sources (those needing Puppeteer) have an extractor here;
    // API sources don't expose a Solve button so this lookup never miss-
    // fires for them.
    const SOURCE_EXTRACTORS = {
      ziprecruiter: ZIPRECRUITER_EXTRACTOR,
      glassdoor:    GLASSDOOR_EXTRACTOR,
      wellfound:    WELLFOUND_EXTRACTOR,
    };
    const inlineExtractorJS = SOURCE_EXTRACTORS[sourceId] || null;
    const result = await openCaptchaResolveWindow(url, event.sender, signal, inlineExtractorJS, secondTabUrl || null);
    const extracted = Array.isArray(result?.items) ? result.items.map(j => ({ ...j, source: sourceId })) : [];

    // Run the SAME age + history dedup the headless search path applies.
    // Without it, this path returned raw items, so every job the user already
    // saw on a prior run re-appeared (and got re-scored) each time they
    // re-solved a source's captcha. This path now only applies to browser-backed
    // sources; Indeed runs through Scrapfly and does not use resolve windows.
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
    // Multi-query sequential solve: if this source had more than one blocked query,
    // pop the just-resolved URL and return the next one so the frontend can re-raise
    // a Solve card for it without requiring a full re-run.
    const remaining = (jobsTelemetry.sourceBlockedUrls?.[sourceId] || []).filter(u => u !== url);
    if (jobsTelemetry.sourceBlockedUrls) jobsTelemetry.sourceBlockedUrls[sourceId] = remaining;
    const nextBlockedUrl = remaining[0] || null;
    if (nextBlockedUrl) logger.info(`[Jobs][${nodeId}] Next blocked URL for ${sourceId}: ${nextBlockedUrl}`);
    return { resolved: !!result.resolved, items, nextBlockedUrl };
  });

  // Resume an Indeed scrape that was interrupted by a login-wall mid-pagination.
  // The user re-authenticates via Settings, then clicks Continue on the source
  // card. Runs only the remaining queries starting from the challenged page so
  // we don't repeat work already captured in pendingJobs.
  handleSafe('resume-job-source', async (event, { sourceId, nodeId, canvasFilePath, maxAgeDays, resumeState } = {}, signal) => {
    if (sourceId !== 'indeed') throw new Error('resume-job-source only supports indeed');
    const { remainingQueries, startPage = 0 } = resumeState || {};
    if (!Array.isArray(remainingQueries) || remainingQueries.length === 0) {
      return { resolved: false, items: [] };
    }
    logger.info(`[Jobs][${nodeId}] Resuming Indeed: ${remainingQueries.length} remaining queries from page ${startPage + 1}`);
    const result = await fetchIndeedListingsBrowser(remainingQueries, signal, maxAgeDays || DEFAULT_MAX_AGE_DAYS, null, null, startPage);
    const extracted = Array.isArray(result?.items) ? result.items.map(j => ({ ...j, source: sourceId })) : [];
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
    logger.info(`[Jobs][${nodeId}] Indeed resume complete: extracted=${extracted.length}, ageDropped=${ageDropped}, historyDropped=${historyDropped}, new=${items.length}`);
    const resolved = items.length > 0 || !result?.warning;
    return { resolved, items };
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

  handleSafe('clear-browser-session', async () => {
    await clearBrowserSession();
    return { success: true };
  });
}
