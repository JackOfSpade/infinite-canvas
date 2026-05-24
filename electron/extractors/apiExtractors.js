/**
 * API-Based Job Extractors — LinkedIn, Greenhouse, Lever, USAJobs.
 *
 * These bypass Puppeteer entirely, using plain HTTP fetch() against
 * publicly accessible JSON APIs or hidden HTML endpoints.
 * Zero WAF risk, structured data, no auth needed.
 *
 * All functions return the standard job shape:
 *   { title, company, location, salary, snippet, url, posted, source }
 */
import { logger } from '../logger.js';
import { queueScrape } from '../ipc/browserPool.js';
import { getRandomUA, refreshDiceApiKey } from '../ipc/stealthBrowser.js';
import { getDiceApiKey } from '../ipc/settings.js';
import { htmlToText } from 'html-to-text';
import { resolveBudget } from '../ipc/scrapeBudget.js';
import { JOB_RESULT_CAP } from '../ipc/resultCaps.js';
import { filterJobsByAge } from '../ipc/jobDateFilter.js';

// Per-source API fetch timeouts. These are SEEDS / ceilings, read through the
// shared scrapeBudget store so they live in one place and share the budget
// machinery used by the browser scrape path. NOTE: unlike the browser path
// these are single-shot fetches with no "time to stable" to learn from, so
// they're not actively learned yet — this indirection removes the scattered
// magic literals and leaves a single hook to switch on learning later.
const API_TIMEOUT_SEEDS = {
  'linkedin-api':   10000,
  'greenhouse-api':  8000,
  'lever-api':       8000,
  'usajobs-api':    10000,
  'remoteok-api':   10000,
  'wwr-api':        10000,
  'reverb-api':     12000,
  'dice-api':       10000,
  'stockx-api':     10000,
};

/** Resolve an API fetch timeout from its seed via the shared budget store. */
function apiTimeout(key) {
  return resolveBudget(key, API_TIMEOUT_SEEDS[key] ?? 10000).timeoutMs;
}


/**
 * Process a list of items concurrently in batches.
 * @param {Array} items - The items to process
 * @param {number} batchSize - Number of items to process concurrently
 * @param {Function} processFn - Async function to run on each item. Should return an array of results.
 * @returns {Array} - Flattened array of all successful results.
 */
async function processInBatches(items, batchSize, processFn, signal = null) {
  const allResults = [];
  for (let i = 0; i < items.length; i += batchSize) {
    if (signal?.aborted) break;
    const batch = items.slice(i, i + batchSize);
    const results = await Promise.allSettled(batch.map(processFn));
    for (const r of results) {
      if (r.status === 'fulfilled' && Array.isArray(r.value)) {
        allResults.push(...r.value);
      }
    }
  }
  return allResults;
}

/**
 * Combines an IPC abort signal (for window closes) with a hard timeout.
 * Prevents fetch requests from hanging forever if the backend drops connection.
 */
function createTimeoutSignal(baseSignal, timeoutMs) {
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([baseSignal, AbortSignal.timeout(timeoutMs)].filter(Boolean));
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs);

  if (baseSignal) {
    if (baseSignal.aborted) {
      clearTimeout(timeoutId);
      controller.abort(baseSignal.reason);
      return controller.signal;
    }
    const abortHandler = () => {
      clearTimeout(timeoutId);
      controller.abort(baseSignal.reason);
    };
    baseSignal.addEventListener('abort', abortHandler, { once: true });
    
    // Cleanup if timeout triggers first
    controller.signal.addEventListener('abort', () => {
      if (controller.signal.reason?.message?.startsWith('Timeout')) {
        baseSignal.removeEventListener('abort', abortHandler);
      }
    }, { once: true });
  }

  return controller.signal;
}

/**
 * A tiny bespoke HTML stripper for snippets (no heavy external dom parser)
 * Real rendering to markdown is handled in python/gemini stages if needed.
 */
function stripHtml(html) {
  if (!html || typeof html !== 'string') return '';
  try {
    return htmlToText(html, { wordwrap: false, selectors: [] });
  } catch {
    return String(html).replace(/<[^>]*>?/gm, ''); // Fallback regex stripping
  }
}

// ── LinkedIn Hidden API ─────────────────────────────────────────────────────
// Public endpoint: linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search
// Returns HTML snippets of job cards — no auth, no page rendering needed.
// Paginates in increments of 25 via the `start` parameter.

/**
 * Fetch jobs from LinkedIn's public API endpoint (no login needed).
 * Accepts a single query string or an array of up to 3 query strings.
 * Multiple queries are walked sequentially with an inter-query jitter pause
 * and deduplicated by job URL so the same posting isn't returned twice.
 */
export async function fetchLinkedInJobs(queries, signal = null, maxAgeDays = null) {
  const { safeApiFetch } = await import('../ipc/antiBotDetector.js');
  const queryList = Array.isArray(queries) ? queries : [queries];
  const seenUrls = new Set();
  const allJobs = [];
  let warning = null;

  for (let qi = 0; qi < queryList.length; qi++) {
    if (signal?.aborted) break;
    // Stop querying if a previous query was blocked — subsequent ones will be too.
    if (warning) break;
    // Inter-query pause (not before the first query). Irregular cadence like the
    // inter-page jitter so a multi-query walk doesn't look like a fixed drumbeat.
    if (qi > 0) await new Promise(res => setTimeout(res, 3000 + Math.floor(Math.random() * 3000)));

    const query = queryList[qi];
    // Walk up to 150 results (6 pages × 25). LinkedIn's guest API is heavily
    // anti-bot, so depth is PACED, not blitzed:
    //   • a jittered 4–8s human-scale gap before each page after the first (a fixed
    //     2s drumbeat is a tell — irregular cadence is the main signal we control),
    //   • an early-exit the moment a page adds no new cards (below), so a low-volume
    //     query never walks all 6 pages — we only go deep when results justify it,
    //   • bail on the first block/non-OK (below), returning whatever we gathered so
    //     far rather than hammering through and turning a soft throttle into a 0.
    const LINKEDIN_MAX_RESULTS = 150;
    for (let start = 0; start < LINKEDIN_MAX_RESULTS; start += 25) {
      if (signal?.aborted) break;
      // Human-scale jittered pause before each subsequent page.
      if (start > 0) await new Promise(res => setTimeout(res, 4000 + Math.floor(Math.random() * 4000)));
      const params = new URLSearchParams({
        keywords: query,
        start: String(start),
        sortBy: 'R', // explicit relevance (= LinkedIn's default; the value its own UI sends, so anti-bot-neutral)
      });
      // LinkedIn's "Time Posted" filter takes seconds (`r604800` = past week)
      if (maxAgeDays && maxAgeDays > 0) {
        params.set('f_TPR', `r${Math.floor(maxAgeDays * 86400)}`);
      }

      const r = await safeApiFetch(`https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?${params}`, {
        headers: {
          'Accept': 'text/html',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Referer': 'https://www.linkedin.com/jobs/search/',
        },
        signal: createTimeoutSignal(signal, apiTimeout('linkedin-api')),
      }, 'linkedin');

      // First detected warning wins — the rest of the loop bails. LinkedIn is
      // a heavy anti-bot source so if page 0 is blocked, page 1 will be too.
      if (r.warning && !warning) warning = r.warning;
      if (!r.ok) {
        logger.warn(`[LinkedIn API] Query ${qi + 1}/${queryList.length} page ${start / 25} returned ${r.status}${r.warning ? ` (${r.warning.code})` : ''}`);
        break;
      }

      const html = r.text;
      if (!html || html.trim().length < 50) break;

      // Parse HTML snippets with regex — LinkedIn returns <li> cards
      // Each card has: title in <h3>, company in <h4>, location, link, datetime
      const cardPattern = /<li[\s\S]*?<\/li>/gi;
      const cards = html.match(cardPattern) || [];

      const before = allJobs.length;
      for (const card of cards) {
        try {
          const titleMatch = card.match(/<h3[^>]*class="[^"]*base-search-card__title[^"]*"[^>]*>([\s\S]*?)<\/h3>/i) ||
                             card.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
          const companyMatch = card.match(/<h4[^>]*class="[^"]*base-search-card__subtitle[^"]*"[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i) ||
                               card.match(/<h4[^>]*>([\s\S]*?)<\/h4>/i);
          const locationMatch = card.match(/<span[^>]*class="[^"]*job-search-card__location[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
          const linkMatch = card.match(/<a[^>]*class="[^"]*base-card__full-link[^"]*"[^>]*href="([^"]+)"/i) ||
                            card.match(/href="(https:\/\/www\.linkedin\.com\/jobs\/view\/[^"]+)"/i);
          const dateMatch = card.match(/<time[^>]*datetime="([^"]+)"[^>]*>([\s\S]*?)<\/time>/i);

          const title = stripHtml(titleMatch?.[1] || '').trim();
          if (!title) continue;

          const url = linkMatch?.[1]?.split('?')[0] || '';
          if (url && seenUrls.has(url)) continue; // cross-query dedup by job URL
          if (url) seenUrls.add(url);

          allJobs.push({
            title,
            company: stripHtml(companyMatch?.[1] || companyMatch?.[2] || '').trim(),
            location: stripHtml(locationMatch?.[1] || '').trim(),
            salary: '',
            snippet: '',
            url,
            posted: dateMatch?.[2] ? stripHtml(dateMatch[2]).trim() : (dateMatch?.[1] || ''),
            source: 'linkedin',
          });
        } catch {
          // Skip malformed cards
        }
      }

      // Page added nothing new → results exhausted (or a soft block served an empty
      // shell). Stop instead of spending more requests walking empty pages.
      if (allJobs.length === before) break;
    }
  }

  // `gathered` = pre-cap match count. When it exceeds the surfaced item count the
  // slice silently dropped in-window jobs (the API analogue of the browser walk's
  // `ceiling` stop); the bug-report funnel flags that so it isn't a silent miss.
  return { items: allJobs.slice(0, JOB_RESULT_CAP), warning, gathered: allJobs.length };
}

// ── Shared query-relevance filter (board/API sources) ────────────────────────
// Greenhouse / Lever / RemoteOK / WeWorkRemotely fetch a fixed company board (or
// the whole feed) and then keyword-filter by the query. The old filter — "match
// if ANY ≥2-char query token appears anywhere in title+company+location+desc" —
// was far too loose: a query like "Junior Cinematographer Denver" matched every
// Datadog "Junior …" role (on "junior") and every Denver-based job (on "denver"),
// flooding a cinematographer search with dozens of unrelated SWE jobs.
//
// Fix: relevance must come from the ROLE/skill nouns, so we (a) drop generic
// tokens — seniority/role-modifiers, work-mode, and structural filler — that
// match everything, and (b) match against the role text (title/company/team),
// NOT the location field or the long JD body, so a city/"remote"/ambient-keyword
// token can't pull in an off-target role. Falls back to any-term if the query is
// entirely generic, so a weird query is never over-filtered to zero.
const JOB_MATCH_STOPWORDS = new Set([
  'junior', 'senior', 'jr', 'sr', 'entry', 'mid', 'midlevel', 'principal', 'staff',
  'lead', 'associate', 'head', 'chief', 'director', 'manager', 'mgr', 'vp', 'svp',
  'intern', 'internship', 'remote', 'hybrid', 'onsite', 'remotefirst',
  'the', 'a', 'an', 'and', 'or', 'for', 'of', 'in', 'at', 'on', 'with', 'to',
  'jobs', 'job', 'position', 'role', 'opening', 'opportunity', 'careers',
]);

const EMPTY_GEO = new Set();

/**
 * Tokenize the candidate's locations (resume profile.locations, e.g.
 * "Denver, CO") into a set of geo tokens to EXCLUDE from role matching.
 * >=3 chars to mirror the meaningful-term threshold ("co" is already too short
 * to qualify, so it's a no-op there but harmless to include the longer ones).
 */
export function buildGeoTermSet(locations = []) {
  const set = new Set();
  for (const loc of (Array.isArray(locations) ? locations : [])) {
    for (const tok of String(loc).toLowerCase().split(/[^a-z0-9]+/)) {
      if (tok.length >= 3) set.add(tok);
    }
  }
  return set;
}

export function jobRelevanceMatch(roleText, query, geoTerms = EMPTY_GEO) {
  const text = String(roleText || '').toLowerCase();
  const terms = String(query || '').toLowerCase().split(/\s+/).filter(t => t.length >= 2);
  // Meaningful = role/skill nouns. Three filters, each dropping a class of token
  // that substring-matches too loosely on a keyword-less company board:
  //  - >=3 chars: a 2-char token ("Denver CO" → "co") matched every
  //    "aCCOunt / COntent / COordinator" title.
  //  - not a generic stopword (seniority / work-mode / structural filler).
  //  - not one of the CANDIDATE'S OWN location tokens. Tech boards bake the city
  //    into the TITLE ("Account Executive - Denver", "Sales Dev Rep (Denver)"),
  //    so a "denver"/"boulder" query token matched every co-located role and
  //    flooded a cinematographer search with ~10 Datadog/Cloudflare SWE+sales
  //    jobs. Location is a filter, never a role-relevance signal — the dedicated
  //    scrapers (Indeed/Glassdoor/LinkedIn) already pass it as a search param.
  // Real role tokens (camera, video, design, engineer…) survive all three.
  const norm = t => t.replace(/[^a-z0-9]/g, '');
  const meaningful = terms.filter(t => {
    const n = norm(t);
    return n.length >= 3 && !JOB_MATCH_STOPWORDS.has(n) && !geoTerms.has(n);
  });
  // Fall back when a query is entirely generic (all stopwords) so we don't
  // over-filter to zero — but only RELAX the stopword rule, never the >=3-char
  // floor (a correctness guard against 2-char substring noise) or the geo
  // exclusion. So "Senior Manager" still matches, while a bare "Denver CO"
  // matches nothing rather than leaking via the "co" substring.
  const useTerms = meaningful.length > 0
    ? meaningful
    : terms.filter(t => norm(t).length >= 3 && !geoTerms.has(norm(t)));
  if (useTerms.length === 0) return false;
  return useTerms.some(t => text.includes(t));
}

// ── Greenhouse API ──────────────────────────────────────────────────────────
// Public JSON endpoint: boards-api.greenhouse.io/v1/boards/{token}/jobs
// Each company has a unique board token.

/** Curated list of top tech companies using Greenhouse ATS. */
const GREENHOUSE_BOARDS = [
  { token: 'figma', company: 'Figma' },
  { token: 'airbnb', company: 'Airbnb' },
  { token: 'stripe', company: 'Stripe' },
  { token: 'discord', company: 'Discord' },
  { token: 'notion', company: 'Notion' },
  { token: 'squarespace', company: 'Squarespace' },
  { token: 'datadog', company: 'Datadog' },
  { token: 'plaid', company: 'Plaid' },
  { token: 'brex', company: 'Brex' },
  { token: 'airtable', company: 'Airtable' },
  { token: 'gitlab', company: 'GitLab' },
  { token: 'hashicorp', company: 'HashiCorp' },
  { token: 'duolingo', company: 'Duolingo' },
  { token: 'cloudflare', company: 'Cloudflare' },
  { token: 'doordash', company: 'DoorDash' },
  { token: 'cockroachlabs', company: 'Cockroach Labs' },
  { token: 'benchling', company: 'Benchling' },
  { token: 'affirm', company: 'Affirm' },
  { token: 'gusto', company: 'Gusto' },
  { token: 'nerdwallet', company: 'NerdWallet' },
  { token: 'reddit', company: 'Reddit' },
  { token: 'robinhood', company: 'Robinhood' },
  { token: 'mongodb', company: 'MongoDB' },
  { token: 'twitch', company: 'Twitch' },
  { token: 'palantir', company: 'Palantir' },
  { token: 'lyft', company: 'Lyft' },
  { token: 'okta', company: 'Okta' },
  { token: 'asana', company: 'Asana' },
  { token: 'webflow', company: 'Webflow' },
  { token: 'vercel', company: 'Vercel' },
];

/**
 * Fetch jobs from Greenhouse boards matching the query.
 * Searches board titles client-side (the API doesn't support keyword search).
 */
export async function fetchGreenhouseJobs(query, signal = null, geoTerms = EMPTY_GEO) {
  const { safeApiFetch } = await import('../ipc/antiBotDetector.js');
  // Greenhouse fans out across dozens of board tokens; collect warnings
  // per-call and pick the strongest at the end so a wave of blocks across
  // the whole platform shows up, not just an isolated 429 from one board.
  const warnings = [];
  const allJobs = await processInBatches(GREENHOUSE_BOARDS, 10, async ({ token, company }) => {
    const r = await safeApiFetch(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=true`, {
      headers: { 'Accept': 'application/json' },
      signal: createTimeoutSignal(signal, apiTimeout('greenhouse-api')),
    }, 'greenhouse');
    if (r.warning) warnings.push(r.warning);
    if (!r.ok) return [];
    const data = r.json;
    return ((data && data.jobs) || []).map(job => ({ ...job, _company: company, _token: token }));
  }, signal);

  // Filter by query relevance — role text only (title + company), not location.
  const matched = allJobs.filter(job =>
    jobRelevanceMatch(`${job.title} ${job._company}`, query, geoTerms));

  const items = matched.slice(0, JOB_RESULT_CAP).map(job => ({
    title: job.title || '',
    company: job._company || '',
    location: job.location?.name || '',
    salary: '',
    snippet: stripHtml(job.content || '').substring(0, 300),
    url: `https://boards.greenhouse.io/${job._token}/jobs/${job.id}`,
    posted: job.updated_at ? new Date(job.updated_at).toLocaleDateString() : '',
    source: 'greenhouse',
  }));
  const strongest = warnings.find(w => w.severity === 'block') || warnings[0] || null;
  return { items, warning: strongest, gathered: matched.length }; // gathered: pre-cap matches (see fetchLinkedInJobs)
}


// ── Lever API ───────────────────────────────────────────────────────────────
// Public JSON endpoint: api.lever.co/v0/postings/{company}?mode=json

/** Curated list of top tech companies using Lever ATS. */
const LEVER_COMPANIES = [
  { slug: 'netflix', company: 'Netflix' },
  { slug: 'openai', company: 'OpenAI' },
  { slug: 'anthropic', company: 'Anthropic' },
  { slug: 'coinbase', company: 'Coinbase' },
  { slug: 'twilio', company: 'Twilio' },
  { slug: 'netlify', company: 'Netlify' },
  { slug: 'postman', company: 'Postman' },
  { slug: 'samsara', company: 'Samsara' },
  { slug: 'clearbit', company: 'Clearbit' },
  { slug: 'grafana', company: 'Grafana Labs' },
  { slug: 'supabase', company: 'Supabase' },
  { slug: 'linear', company: 'Linear' },
  { slug: 'retool', company: 'Retool' },
  { slug: 'snyk', company: 'Snyk' },
  { slug: 'mux', company: 'Mux' },
  { slug: 'fly', company: 'Fly.io' },
  { slug: 'zapier', company: 'Zapier' },
  { slug: 'resend', company: 'Resend' },
  { slug: 'dbt-labs', company: 'dbt Labs' },
  { slug: 'loom', company: 'Loom' },
];

/**
 * Fetch jobs from Lever career pages matching the query.
 */
export async function fetchLeverJobs(query, signal = null, geoTerms = EMPTY_GEO) {
  const { safeApiFetch } = await import('../ipc/antiBotDetector.js');
  const warnings = [];
  const allJobs = await processInBatches(LEVER_COMPANIES, 10, async ({ slug, company }) => {
    const r = await safeApiFetch(`https://api.lever.co/v0/postings/${slug}?mode=json`, {
      headers: { 'Accept': 'application/json' },
      signal: createTimeoutSignal(signal, apiTimeout('lever-api')),
    }, 'lever');
    if (r.warning) warnings.push(r.warning);
    if (!r.ok) return [];
    const data = r.json;
    return (Array.isArray(data) ? data : []).map(job => ({ ...job, _company: company }));
  }, signal);

  // Filter by query relevance — role text (title + company + team), not location.
  const matched = allJobs.filter(job => {
    const roleText = `${job.text} ${job._company} ${job.categories?.team || ''}`;
    return jobRelevanceMatch(roleText, query, geoTerms);
  });

  const items = matched.slice(0, JOB_RESULT_CAP).map(job => ({
    title: job.text || '',
    company: job._company || '',
    location: job.categories?.location || '',
    salary: '',
    snippet: stripHtml(job.descriptionPlain || job.description || '').substring(0, 300),
    url: job.hostedUrl || job.applyUrl || '',
    posted: job.createdAt ? new Date(job.createdAt).toLocaleDateString() : '',
    source: 'lever',
  }));
  const strongest = warnings.find(w => w.severity === 'block') || warnings[0] || null;
  return { items, warning: strongest, gathered: matched.length }; // gathered: pre-cap matches (see fetchLinkedInJobs)
}


// ── USAJobs API ─────────────────────────────────────────────────────────────
// Official API: data.usajobs.gov/api/search
// Requires free API key from developer.usajobs.gov

/**
 * Fetch federal jobs from USAJobs.
 * @param {string} query — search keywords
 * @param {string} apiKey — USAJobs API key (from .env or config)
 * @param {string} email — registered email for User-Agent header
 */
export async function fetchUSAJobs(query, apiKey, email, signal = null, maxAgeDays = 30) {
  if (!apiKey) {
    logger.warn('[USAJobs] No API key configured — skipping');
    // Surface the skip reason as a `warning` so the source card can render
    // it instead of silently sitting at "idle/0". Severity `info` (not block
    // or throttle) so the card colors it neutrally — this isn't a failure,
    // it's a "open Settings → Job Sources to enable this source."
    return {
      items: [],
      warning: {
        code: 'config-missing',
        severity: 'info',
        evidence: 'USAJobs API key + email not set',
        suggestion: 'Get a free key at developer.usajobs.gov, then open Settings → Job Sources and paste the API key + your email to enable this source.',
      },
    };
  }
  const { safeApiFetch } = await import('../ipc/antiBotDetector.js');

  const params = new URLSearchParams({
    Keyword: query,
    ResultsPerPage: '150', // uncapped breadth; USAJobs DatePosted below already keeps these in-window
    DatePosted: String(Math.max(1, Math.floor(maxAgeDays || 30))),
  });

  const r = await safeApiFetch(`https://data.usajobs.gov/api/search?${params}`, {
    headers: {
      'Host': 'data.usajobs.gov',
      'User-Agent': email || 'job-search-app@example.com',
      'Authorization-Key': apiKey,
    },
    signal: createTimeoutSignal(signal, apiTimeout('usajobs-api')),
  }, 'usajobs');

  if (!r.ok) {
    if (r.warning) logger.warn(`[USAJobs] ${r.warning.code}: ${r.warning.evidence}`);
    else logger.error(`[USAJobs] API returned ${r.status}`);
    return { items: [], warning: r.warning };
  }

  const data = r.json;
  const resultItems = data?.SearchResult?.SearchResultItems || [];

  const items = resultItems.slice(0, JOB_RESULT_CAP).map(item => {
    const pos = item.MatchedObjectDescriptor || {};
    const salary = pos.PositionRemuneration?.[0];
    const salaryStr = salary
      ? `$${salary.MinimumRange} - $${salary.MaximumRange} / ${salary.RateIntervalCode}`
      : '';

    return {
      title: pos.PositionTitle || '',
      company: pos.OrganizationName || pos.DepartmentName || '',
      location: pos.PositionLocationDisplay || '',
      salary: salaryStr,
      snippet: stripHtml(pos.QualificationSummary || pos.UserArea?.Details?.MajorDuties?.[0] || '').substring(0, 300),
      url: pos.PositionURI || pos.ApplyURI?.[0] || '',
      posted: pos.PublicationStartDate || '',
      source: 'usajobs',
    };
  });
  return { items, warning: r.warning, gathered: resultItems.length }; // gathered: pre-cap matches (see fetchLinkedInJobs)
}


// ── Shared Utilities ────────────────────────────────────────────────────────


// ── RemoteOK Direct API ─────────────────────────────────────────────────────
// Open JSON endpoint: remoteok.com/api — no auth, no browser, no WAF.
// Returns a raw JSON array of job objects with salary, tags, and company.

/**
 * Fetch jobs from RemoteOK's open JSON API (bypasses Puppeteer entirely).
 */
export async function fetchRemoteOKJobs(query, signal = null, geoTerms = EMPTY_GEO) {
  const { safeApiFetch } = await import('../ipc/antiBotDetector.js');
  const r = await safeApiFetch('https://remoteok.com/api', {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    },
    signal: createTimeoutSignal(signal, apiTimeout('remoteok-api')),
  }, 'remoteok');

  if (!r.ok) {
    if (r.warning) logger.warn(`[RemoteOK API] ${r.warning.code}: ${r.warning.evidence}`);
    else logger.warn(`[RemoteOK API] Returned ${r.status}`);
    return { items: [], warning: r.warning };
  }

  const data = r.json;
  // First element is metadata, rest are jobs
  const jobs = Array.isArray(data) ? data.slice(1) : [];

  // Filter by query relevance — role text (title + company + tags), not the JD body.
  const matched = jobs.filter(job =>
    jobRelevanceMatch(`${job.position || ''} ${job.company || ''} ${(job.tags || []).join(' ')}`, query, geoTerms));

  const items = matched.slice(0, JOB_RESULT_CAP).map(job => ({
    title: job.position || '',
    company: job.company || '',
    location: job.location || 'Remote',
    salary: job.salary || (job.salary_min ? `$${job.salary_min} - $${job.salary_max}` : ''),
    snippet: (job.tags || []).join(', '),
    // RemoteOK's `url` is sometimes already absolute ("https://remoteOK.com/…")
    // and sometimes a relative path; only prefix the relative form, else we get
    // a doubled "https://remoteok.comhttps://remoteOK.com/…" broken link.
    url: job.url ? (String(job.url).startsWith('http') ? job.url : `https://remoteok.com${job.url}`) : '',
    posted: job.date || '',
    source: 'remoteok',
  }));
  return { items, warning: r.warning, gathered: matched.length }; // gathered: pre-cap matches (see fetchLinkedInJobs)
}


// ── WeWorkRemotely RSS Feed ─────────────────────────────────────────────────
// RSS/XML feed at weworkremotely.com — no browser, no rate limits, no WAF.

/**
 * Fetch jobs from WeWorkRemotely's RSS feed (bypasses Puppeteer entirely).
 */
export async function fetchWeWorkRemotelyJobs(query, signal = null, geoTerms = EMPTY_GEO) {
  const { safeApiFetch } = await import('../ipc/antiBotDetector.js');
  const r = await safeApiFetch('https://weworkremotely.com/remote-jobs.rss', {
    headers: {
      'Accept': 'application/rss+xml, application/xml, text/xml',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    },
    signal: createTimeoutSignal(signal, apiTimeout('wwr-api')),
  }, 'weworkremotely');

  if (!r.ok) {
    if (r.warning) logger.warn(`[WWR RSS] ${r.warning.code}: ${r.warning.evidence}`);
    else logger.warn(`[WWR RSS] Returned ${r.status}`);
    return { items: [], warning: r.warning };
  }

  const xml = r.text;

  // Parse RSS items with regex (no XML parser dependency needed)
  const itemPattern = /<item>([\s\S]*?)<\/item>/gi;
  const rssItems = xml.match(itemPattern) || [];
  const jobs = [];

  for (const item of rssItems) {
    const titleMatch = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/i) ||
                        item.match(/<title>(.*?)<\/title>/i);
    const linkMatch = item.match(/<link>(.*?)<\/link>/i);
    const descMatch = item.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/i) ||
                       item.match(/<description>([\s\S]*?)<\/description>/i);
    const pubDateMatch = item.match(/<pubDate>(.*?)<\/pubDate>/i);
    const regionMatch = item.match(/<region><!\[CDATA\[(.*?)\]\]><\/region>/i) ||
                         item.match(/<region>(.*?)<\/region>/i);

    const title = titleMatch?.[1]?.trim() || '';
    if (!title) continue;

    // Extract company from title (WWR formats as "Company: Job Title")
    const titleParts = title.split(':');
    const company = titleParts.length > 1 ? titleParts[0].trim() : '';
    const jobTitle = titleParts.length > 1 ? titleParts.slice(1).join(':').trim() : title;

    // Filter by query relevance — role text only ("Company: Role" title), not
    // the JD body (matching the description over-matches on ambient keywords).
    if (!jobRelevanceMatch(title, query, geoTerms)) continue;

    jobs.push({
      title: jobTitle,
      company,
      location: regionMatch?.[1]?.trim() || 'Remote',
      salary: '',
      snippet: stripHtml(descMatch?.[1] || '').substring(0, 300),
      url: linkMatch?.[1]?.trim() || '',
      posted: pubDateMatch?.[1] ? new Date(pubDateMatch[1]).toLocaleDateString() : '',
      source: 'weworkremotely',
    });
  }

  return { items: jobs.slice(0, JOB_RESULT_CAP), warning: r.warning, gathered: jobs.length }; // gathered: pre-cap matches (see fetchLinkedInJobs)
}


// ── Reverb Internal REST API ────────────────────────────────────────────────
// Internal endpoint: api.reverb.com/api/listings/all
// Requires Accept-Version: 3.0 and Accept: application/hal+json headers.
// Returns structured JSON with instrument pricing, condition, and seller data.

/**
 * Fetch marketplace listings from Reverb's internal REST API.
 * Returns the standard comp shape for pricing comparison.
 */
export async function fetchReverbListings(query, soldOnly = false, signal = null) {
  const { safeApiFetch } = await import('../ipc/antiBotDetector.js');
  const params = new URLSearchParams({ query });
  if (soldOnly) params.set('state', 'ended');

  const r = await safeApiFetch(`https://api.reverb.com/api/listings/all?${params}`, {
    headers: {
      'Accept': 'application/hal+json',
      'Accept-Version': '3.0',
      'Content-Type': 'application/hal+json',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    },
    signal: createTimeoutSignal(signal, apiTimeout('reverb-api')),
  }, 'reverb');

  if (!r.ok) {
    if (r.warning) logger.warn(`[Reverb API] ${r.warning.code}: ${r.warning.evidence}`);
    else logger.warn(`[Reverb API] Returned ${r.status}`);
    return { items: [], warning: r.warning };
  }

  const data = r.json;
  const listings = data?.listings || data?._embedded?.listings || [];

  const items = listings.slice(0, 25).map(listing => {
    const price = listing.price?.amount ? parseFloat(listing.price.amount) : 0;
    return {
      title: listing.title || listing.make_model || '',
      price,
      priceText: price > 0 ? `$${price.toFixed(2)}` : '',
      condition: listing.condition?.display_name || listing.condition?.slug || '',
      soldDate: listing.state === 'ended' ? (listing.sold_date || 'Sold') : '',
      seller: listing.seller?.feedback_percentage ? `${listing.seller.feedback_percentage}%` : '',
      url: listing._links?.web?.href || listing.web_url || '',
      source: 'reverb',
    };
  });
  return { items, warning: r.warning };
}

// ── Dice Public API ─────────────────────────────────────────────────────────
// DHI Group (Dice's parent) exposes a public job search API used by the Dice
// frontend. Returns structured JSON with all fields we need.
// Zero WAF risk — this is a direct API endpoint, no browser needed.
//
// Discovered during tier upgrade audit: previously Tier 3 (Puppeteer),
// now upgraded to Tier 1 (direct API).

// Dice API key is persisted in settings (getDiceApiKey) and auto-refreshed
// by refreshDiceApiKey() when the server returns 500 — see stealthBrowser.js.

/**
 * Fetch job listings from Dice via their public API (Tier 1).
 * @param {string} query — job search query
 * @param {string} [location] — optional location filter
 * @param {number} [maxAgeDays] — keep only postings within this window (client-side)
 * @returns {Promise<Array>} — standardized job objects
 */
const DICE_MAX_RETRIES = 3;
const DICE_RETRY_DELAYS_MS = [1000, 2000, 4000];

export async function fetchDiceListings(query, location = '', signal = null, maxAgeDays = null) {
  const { safeApiFetch } = await import('../ipc/antiBotDetector.js');
  const params = new URLSearchParams({
    q: query,
    countryCode2: 'US',
    radius: '30',
    radiusUnit: 'mi',
    page: '1',
    // Pull a WIDE relevance-ranked page, then keep only in-window jobs and take
    // the top JOB_RESULT_CAP of those (below) — so the cap holds the most-relevant
    // RECENT matches, not a relevance mix that's mostly age-dropped downstream.
    // We over-pull on purpose: relevance sort interleaves stale postings, and a
    // tight window has a small in-window fraction (probed: ~3-4% at 1 day, ~32% at
    // 7 days), so volume is what guarantees a full cap of in-window matches. Dice
    // has no date sort that helps and `filters.postedDate` only spans 1/3/7 days —
    // narrower than the 21-day default — so the window is enforced client-side.
    // pageSize is honored well past this (probed to 1000+); still one call, no paging.
    sortBy: 'relevance', // explicit (= Dice's default) so an API default change can't silently flip us off relevance
    pageSize: '1000',
    ...(location ? { location } : {}),
  });

  const url = `https://job-search-api.svc.dhigroupinc.com/v1/dice/jobs/search?${params}`;
  let r;
  for (let attempt = 0; attempt <= DICE_MAX_RETRIES; attempt++) {
    if (signal?.aborted) throw new Error('Aborted');
    if (attempt > 0) {
      const delay = DICE_RETRY_DELAYS_MS[attempt - 1] ?? 4000;
      logger.info(`[Dice API] Retry ${attempt}/${DICE_MAX_RETRIES} in ${delay}ms (last status: ${r?.status ?? '?'})`);
      await new Promise(res => setTimeout(res, delay));
      if (signal?.aborted) throw new Error('Aborted');
    }
    r = await safeApiFetch(url, {
      headers: {
        'User-Agent': getRandomUA(),
        'x-api-key': getDiceApiKey(),
        'Accept': 'application/json',
      },
      signal: createTimeoutSignal(signal, apiTimeout('dice-api')),
    }, 'dice');
    if (r.ok) break;
    if (r.status >= 500 && attempt < DICE_MAX_RETRIES) continue; // retry on server errors
    break; // non-5xx or retries exhausted — fall through to error handling
  }

  if (!r.ok) {
    if (r.status >= 500) {
      // API key may have rotated — intercept the current key from dice.com and retry once.
      const newKey = await refreshDiceApiKey();
      if (newKey) {
        logger.info('[Dice API] Retrying with refreshed key');
        const retryR = await safeApiFetch(url, {
          headers: {
            'User-Agent': getRandomUA(),
            'x-api-key': newKey,
            'Accept': 'application/json',
          },
          signal: createTimeoutSignal(signal, apiTimeout('dice-api')),
        }, 'dice');
        if (retryR.ok) {
          r = retryR; // use the successful retry response going forward
        } else {
          throw new Error(`Dice API unavailable — returned HTTP ${r.status} after ${DICE_MAX_RETRIES + 1} attempts + 1 key-refresh retry.`);
        }
      } else {
        throw new Error(`Dice API unavailable — returned HTTP ${r.status} after ${DICE_MAX_RETRIES + 1} attempt(s). Key refresh also failed — try again later.`);
      }
    } else {
      if (r.warning) logger.warn(`[Dice API] ${r.warning.code}: ${r.warning.evidence}`);
      else logger.warn(`[Dice API] Returned ${r.status}`);
      return { items: [], warning: r.warning };
    }
  }

  const data = r.json;
  const jobs = data?.data || [];

  logger.info(`[Dice API] Found ${jobs.length} jobs for "${query}"`);

  const mapped = jobs.map(job => ({
    title: job.title || '',
    company: job.companyName || '',
    location: job.jobLocation?.displayName || '',
    salary: job.salary || '',
    snippet: (job.summary || '').substring(0, 300),
    url: job.detailsPageUrl || `https://www.dice.com/job-detail/${job.guid || job.id}`,
    posted: job.postedDate || '',
    source: 'dice',
    remote: job.workFromHomeAvailability === 'TRUE',
    employmentType: job.employmentType || '',
    easyApply: job.easyApply || false,
  }));
  // Date-filter the wide relevance pull, THEN cap — so the kept JOB_RESULT_CAP are
  // the most-relevant IN-WINDOW jobs (reuses the shared age filter; same cutoff the
  // global pass applies, so this is a no-op there, not a second policy). `gathered`
  // = in-window matches before the cap, so the funnel flags when there were more.
  const inWindow = maxAgeDays ? filterJobsByAge(mapped, maxAgeDays) : mapped;
  const items = inWindow.slice(0, JOB_RESULT_CAP);
  return { items, warning: r.warning, gathered: inWindow.length };
}


// ── StockX Algolia API Bypass ───────────────────────────────────────────────
// StockX outsources search to Algolia. We extract the API keys from the page
// HTML, then query Algolia directly — bypassing StockX's PerimeterX WAF.
// Keys rotate, so we extract them fresh each session.
//
// Known StockX Algolia Application ID — this is a public, client-facing value
// embedded in StockX's frontend JS. It's tied to their Algolia account and
// almost never changes (years). The search API key, however, may rotate.
const HARDCODED_STOCKX_APP_ID = '2FWOTDVM2O';

// Architecture: Try hardcoded App ID + cached API key first (Tier 1).
//               If keys expired → Puppeteer stealth bootstrap to extract fresh keys.
//               All data queries go directly to Algolia API (Tier 1).
// Plain fetch() WILL NOT WORK for key extraction — PerimeterX serves a JS
// challenge page that requires full browser rendering to solve.

let algoliaKeys = null; // Cache keys for the session
let lastStockXErrorTime = 0; // Cooldown for extraction failures

// Extractor JS that runs inside the Puppeteer page to grab Algolia keys.
// Searches all <script> tags and window properties for the key/appId pair.
const STOCKX_KEY_EXTRACTOR = `
(function() {
  // Strategy 1: Search inline scripts for Algolia config
  const scripts = document.querySelectorAll('script');
  for (const script of scripts) {
    const text = script.textContent || '';
    const appIdMatch = text.match(/x-algolia-application-id['":\\s]+([A-Z0-9]+)/i) ||
                       text.match(/algoliaApplicationId['":\\s]+['"]([A-Z0-9]+)['"]/i) ||
                       text.match(/"applicationId":\\s*"([A-Z0-9]+)"/i);
    const apiKeyMatch = text.match(/x-algolia-api-key['":\\s]+([a-f0-9]+)/i) ||
                        text.match(/algoliaApiKey['":\\s]+['"]([a-f0-9]+)['"]/i) ||
                        text.match(/"apiKey":\\s*"([a-f0-9]+)"/i);
    if (appIdMatch && apiKeyMatch) {
      return { appId: appIdMatch[1], apiKey: apiKeyMatch[1] };
    }
  }

  // Strategy 2: Check __NEXT_DATA__ for Algolia config
  try {
    const ndEl = document.getElementById('__NEXT_DATA__');
    if (ndEl) {
      const nd = JSON.parse(ndEl.textContent);
      const config = nd?.props?.pageProps?.algoliaConfig ||
                     nd?.runtimeConfig?.algolia ||
                     nd?.props?.pageProps?.searchConfig;
      if (config?.appId && config?.apiKey) {
        return { appId: config.appId, apiKey: config.apiKey };
      }
    }
  } catch {}

  // Strategy 3: Check global window properties
  try {
    if (window.__algoliaConfig) return window.__algoliaConfig;
    if (window.__STOCKX_CONFIG__?.algolia) return window.__STOCKX_CONFIG__.algolia;
  } catch {}

  return null;
})()
`;

/**
 * Fetch marketplace listings from StockX via Algolia API bypass.
 *
 * Tier escalation:
 *   1. Try cached Algolia keys (Tier 1 — pure API, zero browser)
 *   2. If keys missing/expired: extract via Puppeteer stealth (Tier 3 bootstrap, once per session)
 *   3. All data queries go to Algolia directly (Tier 1)
 */
export async function fetchStockXListings(query, signal = null) {
  const { safeApiFetch } = await import('../ipc/antiBotDetector.js');
  let bootstrapWarning = null;
  try {
    // Phase 1: Key Extraction Bootstrap (once per session)
    if (!algoliaKeys) {
      if (Date.now() - lastStockXErrorTime < 300000) {
        logger.warn('[StockX] Bootstrap cooldown active — skipping');
        return { items: [], warning: {
          code: 'stockx-bootstrap-cooldown',
          severity: 'block',
          evidence: '[stockx] Key extraction failed recently — 5 min cooldown active',
          suggestion: 'PerimeterX likely blocked the key-extraction page. Wait 5 minutes; if it persists, the stealth browser fingerprint may need rotation.',
        } };
      }

      logger.info('[StockX] No cached keys — extracting via stealth browser...');
      try {
        // queueScrape now returns { data, warning } — propagate either the
        // extracted keys or the anti-bot warning from the page fetch.
        const wrapped = await queueScrape(
          `https://stockx.com/search?s=${encodeURIComponent(query)}`,
          STOCKX_KEY_EXTRACTOR,
          {
            waitMs: 3000,
            timeoutMs: 35000,
            scrollFirst: false,
            dismissCookies: true,
            referer: 'https://www.google.com/',
            signal,
          }
        );
        const keys = wrapped?.data ?? null;
        // If the bootstrap fetch tripped PerimeterX, browserPool's detector
        // already flagged it. Save the warning so we surface it even if we
        // fall back to the hardcoded App ID and the Algolia query "works".
        if (wrapped?.warning) bootstrapWarning = wrapped.warning;

        if (keys?.appId && keys?.apiKey) {
          algoliaKeys = keys;
          logger.info(`[StockX] Algolia keys extracted: appId=${keys.appId.substring(0, 4)}...`);
        } else {
          lastStockXErrorTime = Date.now();
          algoliaKeys = { appId: HARDCODED_STOCKX_APP_ID, apiKey: '' };
          logger.warn('[StockX] Bootstrap failed — using hardcoded fallback. Cooldown active.');
        }
      } catch (err) {
        lastStockXErrorTime = Date.now();
        logger.error('[StockX] Extraction error:', err.message);
        return { items: [], warning: bootstrapWarning || {
          code: 'stockx-bootstrap-failed',
          severity: 'block',
          evidence: `[stockx] key extraction threw: ${err.message}`,
          suggestion: 'PerimeterX likely served a JS challenge that stealth couldn\'t solve. Manual session refresh or proxy may be required.',
        } };
      }
    }

    if (!algoliaKeys?.appId) return { items: [], warning: bootstrapWarning };

    // Phase 2: Query Algolia directly
    const r = await safeApiFetch(
      `https://${algoliaKeys.appId}-dsn.algolia.net/1/indexes/products/query`,
      {
        method: 'POST',
        headers: {
          'X-Algolia-Application-Id': algoliaKeys.appId,
          'X-Algolia-API-Key': algoliaKeys.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query,
          hitsPerPage: 25,
        }),
        signal: createTimeoutSignal(signal, apiTimeout('stockx-api')),
      },
      'stockx-algolia'
    );

    if (!r.ok) {
      if (r.warning) logger.warn(`[StockX Algolia] ${r.warning.code}: ${r.warning.evidence}`);
      else logger.warn(`[StockX Algolia] Returned ${r.status}`);
      algoliaKeys = null;
      // Prefer the Algolia warning when present; fall back to the bootstrap
      // warning since the user wants to see ANY signal from this pipeline.
      return { items: [], warning: r.warning || bootstrapWarning };
    }

    const data = r.json;
    const hits = data?.hits || [];

    const items = hits.slice(0, 25).map(hit => {
      const lastSale = hit.last_sale || hit.market?.lastSale || 0;
      const lowestAsk = hit.lowest_ask || hit.market?.lowestAsk || 0;
      const price = lastSale || lowestAsk;

      return {
        title: hit.name || hit.title || '',
        price,
        priceText: price > 0 ? `$${price}` : '',
        lastSale: lastSale > 0 ? `$${lastSale}` : '',
        lowestAsk: lowestAsk > 0 ? `$${lowestAsk}` : '',
        condition: 'New / Deadstock',
        url: hit.url ? `https://stockx.com/${hit.url}` : '',
        source: 'stockx',
      };
    });
    // Surface bootstrapWarning even on a successful Algolia query — the user
    // should know if we fell back to hardcoded keys because StockX blocked
    // the key page, even if the search itself worked.
    return { items, warning: r.warning || bootstrapWarning };
  } catch (error) {
    logger.error('[StockX Algolia] Fetch failed:', error?.message || String(error));
    return { items: [], warning: bootstrapWarning };
  }
}
