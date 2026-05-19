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
import { getRandomUA } from '../ipc/stealthBrowser.js';
import { htmlToText } from 'html-to-text';


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
 * This replaces the Puppeteer-based LinkedIn scraper.
 */
export async function fetchLinkedInJobs(query, signal = null, maxAgeDays = null) {
  const { safeApiFetch } = await import('../ipc/antiBotDetector.js');
  const allJobs = [];
  let warning = null;

  // Fetch 2 pages (50 results max) to stay polite
  for (let start = 0; start < 50; start += 25) {
    if (signal?.aborted) break;
    const params = new URLSearchParams({
      keywords: query,
      start: String(start),
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
      signal: createTimeoutSignal(signal, 10000),
    }, 'linkedin');

    // First detected warning wins — the rest of the loop bails. LinkedIn is
    // a heavy anti-bot source so if page 0 is blocked, page 1 will be too.
    if (r.warning && !warning) warning = r.warning;
    if (!r.ok) {
      logger.warn(`[LinkedIn API] Page ${start / 25} returned ${r.status}${r.warning ? ` (${r.warning.code})` : ''}`);
      break;
    }

    const html = r.text;
    if (!html || html.trim().length < 50) break;

    // Parse HTML snippets with regex — LinkedIn returns <li> cards
    // Each card has: title in <h3>, company in <h4>, location, link, datetime
    const cardPattern = /<li[\s\S]*?<\/li>/gi;
    const cards = html.match(cardPattern) || [];

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

        allJobs.push({
          title,
          company: stripHtml(companyMatch?.[1] || companyMatch?.[2] || '').trim(),
          location: stripHtml(locationMatch?.[1] || '').trim(),
          salary: '',
          snippet: '',
          url: linkMatch?.[1]?.split('?')[0] || '', // Strip tracking params
          posted: dateMatch?.[2] ? stripHtml(dateMatch[2]).trim() : (dateMatch?.[1] || ''),
          source: 'linkedin',
        });
      } catch {
        // Skip malformed cards
      }
    }

    // Polite delay between pages — report recommends 2-3s minimum for LinkedIn
    if (start < 25) await new Promise(r => setTimeout(r, 2000));
  }

  return { items: allJobs.slice(0, 30), warning };
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
export async function fetchGreenhouseJobs(query, signal = null) {
  const { safeApiFetch } = await import('../ipc/antiBotDetector.js');
  const queryLower = query.toLowerCase();
  const queryTerms = queryLower.split(/\s+/).filter(t => t.length >= 2);
  // Greenhouse fans out across dozens of board tokens; collect warnings
  // per-call and pick the strongest at the end so a wave of blocks across
  // the whole platform shows up, not just an isolated 429 from one board.
  const warnings = [];
  const allJobs = await processInBatches(GREENHOUSE_BOARDS, 10, async ({ token, company }) => {
    const r = await safeApiFetch(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=true`, {
      headers: { 'Accept': 'application/json' },
      signal: createTimeoutSignal(signal, 8000),
    }, 'greenhouse');
    if (r.warning) warnings.push(r.warning);
    if (!r.ok) return [];
    const data = r.json;
    return ((data && data.jobs) || []).map(job => ({ ...job, _company: company, _token: token }));
  }, signal);

  // Filter by query relevance
  const matched = allJobs.filter(job => {
    const text = `${job.title} ${job._company} ${job.location?.name || ''}`.toLowerCase();
    return queryTerms.some(term => text.includes(term));
  });

  const items = matched.slice(0, 30).map(job => ({
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
  return { items, warning: strongest };
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
export async function fetchLeverJobs(query, signal = null) {
  const { safeApiFetch } = await import('../ipc/antiBotDetector.js');
  const queryLower = query.toLowerCase();
  const queryTerms = queryLower.split(/\s+/).filter(t => t.length >= 2);
  const warnings = [];
  const allJobs = await processInBatches(LEVER_COMPANIES, 10, async ({ slug, company }) => {
    const r = await safeApiFetch(`https://api.lever.co/v0/postings/${slug}?mode=json`, {
      headers: { 'Accept': 'application/json' },
      signal: createTimeoutSignal(signal, 8000),
    }, 'lever');
    if (r.warning) warnings.push(r.warning);
    if (!r.ok) return [];
    const data = r.json;
    return (Array.isArray(data) ? data : []).map(job => ({ ...job, _company: company }));
  }, signal);

  // Filter by query relevance
  const matched = allJobs.filter(job => {
    const text = `${job.text} ${job._company} ${job.categories?.location || ''} ${job.categories?.team || ''}`.toLowerCase();
    return queryTerms.some(term => text.includes(term));
  });

  const items = matched.slice(0, 30).map(job => ({
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
  return { items, warning: strongest };
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
    // it's a "you need to set USAJOBS_API_KEY in your env to enable this."
    return {
      items: [],
      warning: {
        code: 'config-missing',
        severity: 'info',
        evidence: 'USAJOBS_API_KEY env var not set',
        suggestion: 'Get a free key at developer.usajobs.gov and set USAJOBS_API_KEY + USAJOBS_EMAIL in your env to enable this source.',
      },
    };
  }
  const { safeApiFetch } = await import('../ipc/antiBotDetector.js');

  const params = new URLSearchParams({
    Keyword: query,
    ResultsPerPage: '25',
    DatePosted: String(Math.max(1, Math.floor(maxAgeDays || 30))),
  });

  const r = await safeApiFetch(`https://data.usajobs.gov/api/search?${params}`, {
    headers: {
      'Host': 'data.usajobs.gov',
      'User-Agent': email || 'job-search-app@example.com',
      'Authorization-Key': apiKey,
    },
    signal: createTimeoutSignal(signal, 10000),
  }, 'usajobs');

  if (!r.ok) {
    if (r.warning) logger.warn(`[USAJobs] ${r.warning.code}: ${r.warning.evidence}`);
    else logger.error(`[USAJobs] API returned ${r.status}`);
    return { items: [], warning: r.warning };
  }

  const data = r.json;
  const resultItems = data?.SearchResult?.SearchResultItems || [];

  const items = resultItems.slice(0, 30).map(item => {
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
  return { items, warning: r.warning };
}


// ── Shared Utilities ────────────────────────────────────────────────────────


// ── RemoteOK Direct API ─────────────────────────────────────────────────────
// Open JSON endpoint: remoteok.com/api — no auth, no browser, no WAF.
// Returns a raw JSON array of job objects with salary, tags, and company.

/**
 * Fetch jobs from RemoteOK's open JSON API (bypasses Puppeteer entirely).
 */
export async function fetchRemoteOKJobs(query, signal = null) {
  const { safeApiFetch } = await import('../ipc/antiBotDetector.js');
  const r = await safeApiFetch('https://remoteok.com/api', {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    },
    signal: createTimeoutSignal(signal, 10000),
  }, 'remoteok');

  if (!r.ok) {
    if (r.warning) logger.warn(`[RemoteOK API] ${r.warning.code}: ${r.warning.evidence}`);
    else logger.warn(`[RemoteOK API] Returned ${r.status}`);
    return { items: [], warning: r.warning };
  }

  const data = r.json;
  // First element is metadata, rest are jobs
  const jobs = Array.isArray(data) ? data.slice(1) : [];
  const queryLower = query.toLowerCase();
  const queryTerms = queryLower.split(/\s+/).filter(t => t.length >= 2);

  // Filter by query relevance
  const matched = jobs.filter(job => {
    const text = `${job.position || ''} ${job.company || ''} ${(job.tags || []).join(' ')} ${job.description || ''}`.toLowerCase();
    return queryTerms.some(term => text.includes(term));
  });

  const items = matched.slice(0, 30).map(job => ({
    title: job.position || '',
    company: job.company || '',
    location: job.location || 'Remote',
    salary: job.salary || (job.salary_min ? `$${job.salary_min} - $${job.salary_max}` : ''),
    snippet: (job.tags || []).join(', '),
    url: job.url ? `https://remoteok.com${job.url}` : '',
    posted: job.date || '',
    source: 'remoteok',
  }));
  return { items, warning: r.warning };
}


// ── WeWorkRemotely RSS Feed ─────────────────────────────────────────────────
// RSS/XML feed at weworkremotely.com — no browser, no rate limits, no WAF.

/**
 * Fetch jobs from WeWorkRemotely's RSS feed (bypasses Puppeteer entirely).
 */
export async function fetchWeWorkRemotelyJobs(query, signal = null) {
  const { safeApiFetch } = await import('../ipc/antiBotDetector.js');
  const r = await safeApiFetch('https://weworkremotely.com/remote-jobs.rss', {
    headers: {
      'Accept': 'application/rss+xml, application/xml, text/xml',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    },
    signal: createTimeoutSignal(signal, 10000),
  }, 'weworkremotely');

  if (!r.ok) {
    if (r.warning) logger.warn(`[WWR RSS] ${r.warning.code}: ${r.warning.evidence}`);
    else logger.warn(`[WWR RSS] Returned ${r.status}`);
    return { items: [], warning: r.warning };
  }

  const xml = r.text;
  const queryLower = query.toLowerCase();
  const queryTerms = queryLower.split(/\s+/).filter(t => t.length >= 2);

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

    // Filter by query relevance
    const text = `${title} ${stripHtml(descMatch?.[1] || '')}`.toLowerCase();
    const matches = queryTerms.some(term => text.includes(term));
    if (!matches) continue;

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

  return { items: jobs.slice(0, 30), warning: r.warning };
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
    signal: createTimeoutSignal(signal, 12000),
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

const DICE_API_KEY = '1YAt0R9wBg4WfsF9VB2778F5CHLAPMVW3WAZcKd8';

/**
 * Fetch job listings from Dice via their public API (Tier 1).
 * @param {string} query — job search query
 * @param {string} [location] — optional location filter
 * @returns {Promise<Array>} — standardized job objects
 */
export async function fetchDiceListings(query, location = '', signal = null) {
  const { safeApiFetch } = await import('../ipc/antiBotDetector.js');
  const params = new URLSearchParams({
    q: query,
    countryCode2: 'US',
    radius: '30',
    radiusUnit: 'mi',
    page: '1',
    pageSize: '25',
    ...(location ? { location } : {}),
  });

  const r = await safeApiFetch(
    `https://job-search-api.svc.dhigroupinc.com/v1/dice/jobs/search?${params}`,
    {
      headers: {
        'User-Agent': getRandomUA(),
        'x-api-key': DICE_API_KEY,
        'Accept': 'application/json',
      },
      signal: createTimeoutSignal(signal, 10000),
    },
    'dice'
  );

  if (!r.ok) {
    if (r.warning) logger.warn(`[Dice API] ${r.warning.code}: ${r.warning.evidence}`);
    else logger.warn(`[Dice API] Returned ${r.status}`);
    return { items: [], warning: r.warning };
  }

  const data = r.json;
  const jobs = data?.data || [];

  logger.info(`[Dice API] Found ${jobs.length} jobs for "${query}"`);

  const items = jobs.map(job => ({
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
  return { items, warning: r.warning };
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
        signal: createTimeoutSignal(signal, 10000),
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
