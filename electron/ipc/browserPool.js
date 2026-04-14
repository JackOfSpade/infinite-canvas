/**
 * Browser Pool — Manages concurrent stealth scraping through puppeteer-extra.
 *
 * Anti-ban architecture:
 *   - Max 3 simultaneous pages total
 *   - Max 1 concurrent page per domain (prevents pattern detection)
 *   - Per-domain cooldown (3–8s between requests to same domain)
 *   - Exponential backoff on errors/blocks (60s → 120s → 240s)
 *   - Gaussian-distributed inter-request delays (not uniform = detectable)
 *
 * Public API:
 *   queueScrape(url, extractorJS, options) → Promise<any>
 *   scrapeMultiple(tasks) → Promise<Array<{id, success, data?, error?}>>
 */
import {
  createStealthPage,
  humanMouseMove,
  dismissCookieBanner,
  humanScroll,
} from './stealthBrowser.js';

const MAX_CONCURRENT = 3;
const MAX_PER_DOMAIN = 1; // Only 1 concurrent page per domain

let activeCount = 0;
const activeDomains = new Map(); // domain -> count of active pages
const queue = [];

// ── Utility Functions ───────────────────────────────────────────────────────

function extractDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'unknown';
  }
}

/** Gaussian-distributed random delay (more natural than uniform). */
function gaussianDelay(mean, stddev) {
  const u1 = Math.random();
  const u2 = Math.random();
  const normal = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.max(1000, Math.round(mean + normal * stddev));
}

// ── Per-Domain Rate Limiter ─────────────────────────────────────────────────
const domainLastRequest = new Map();
const domainBackoff = new Map();

// Domain-specific RPM policies (per deep research report, P6).
// LinkedIn is aggressively defended; StockX uses PerimeterX; eBay is moderate.
const DOMAIN_POLICIES = {
  'linkedin.com':     { rpm: 1, baseCooldownMs: 60000 },   // ~1 req/min, daily cap
  'indeed.com':       { rpm: 5, baseCooldownMs: 12000 },   // 5 req/min
  'glassdoor.com':    { rpm: 3, baseCooldownMs: 20000 },   // Cloudflare-heavy
  'stockx.com':       { rpm: 3, baseCooldownMs: 20000 },   // PerimeterX
  'ebay.com':         { rpm: 15, baseCooldownMs: 4000 },   // Moderate tolerance
  'poshmark.com':     { rpm: 5, baseCooldownMs: 12000 },
  'mercari.com':      { rpm: 8, baseCooldownMs: 8000 },
  'reverb.com':       { rpm: 10, baseCooldownMs: 6000 },
  'swappa.com':       { rpm: 10, baseCooldownMs: 6000 },
  'depop.com':        { rpm: 5, baseCooldownMs: 12000 },
};
const DEFAULT_POLICY = { rpm: 5, baseCooldownMs: 12000 };

function getDomainPolicy(domain) {
  for (const [key, policy] of Object.entries(DOMAIN_POLICIES)) {
    if (domain.includes(key)) return policy;
  }
  return DEFAULT_POLICY;
}

/** Wait until it’s safe to hit a domain again, using domain-specific RPM. */
async function waitForDomainCooldown(domain) {
  const lastReq = domainLastRequest.get(domain) || 0;
  const backoffMult = domainBackoff.get(domain) || 1;
  const policy = getDomainPolicy(domain);
  const baseCooldown = gaussianDelay(policy.baseCooldownMs, policy.baseCooldownMs * 0.3);
  const cooldown = baseCooldown * backoffMult;
  const elapsed = Date.now() - lastReq;

  if (elapsed < cooldown) {
    const waitMs = cooldown - elapsed;
    await new Promise(r => setTimeout(r, waitMs));
  }

  domainLastRequest.set(domain, Date.now());
}

/** Mark a domain as having encountered an error (triggers exponential backoff). */
function markDomainError(domain) {
  const current = domainBackoff.get(domain) || 1;
  domainBackoff.set(domain, Math.min(current * 2, 16)); // Max 16x = ~64s cooldown
  console.warn(`[BrowserPool] Domain ${domain} backoff increased to ${domainBackoff.get(domain)}x`);
  // Record for Tier 4 escalation tracking
  recordDomainAttempt(domain, false);
}

/** Mark a domain as successful (gradually reduces backoff). */
function markDomainSuccess(domain) {
  const current = domainBackoff.get(domain) || 1;
  if (current > 1) {
    domainBackoff.set(domain, Math.max(1, current * 0.5)); // Halve backoff on success
  }
  // Record for Tier 4 escalation tracking
  recordDomainAttempt(domain, true);
}

function canProcessTask(task) {
  const domain = extractDomain(task.url);
  const domainActive = activeDomains.get(domain) || 0;
  return domainActive < MAX_PER_DOMAIN;
}

function processQueue() {
  while (activeCount < MAX_CONCURRENT && queue.length > 0) {
    // Find the first task whose domain isn’t at capacity
    const taskIdx = queue.findIndex(t => canProcessTask(t));
    if (taskIdx === -1) break; // All queued tasks are for busy domains

    const { url, extractorJS, options, resolve, reject } = queue.splice(taskIdx, 1)[0];
    const domain = extractDomain(url);

    activeCount++;
    activeDomains.set(domain, (activeDomains.get(domain) || 0) + 1);

    executeScrape(url, extractorJS, options)
      .then(resolve)
      .catch(reject)
      .finally(() => {
        activeCount--;
        const count = activeDomains.get(domain) || 1;
        if (count <= 1) activeDomains.delete(domain);
        else activeDomains.set(domain, count - 1);
        processQueue();
      });
  }
}

/**
 * Internal — creates a stealth page, navigates, extracts data.
 *
 * Options:
 *   waitMs       — extra delay after page load (default 2000)
 *   timeoutMs    — hard timeout for the entire operation (default 30000)
 *   waitFor      — CSS selector to wait for before extracting (optional)
 *   scrollFirst  — if true, simulate human scrolling before extraction (default false)
 *   dismissCookies — if true, try to dismiss cookie banners (default true)
 *   referer      — spoofed Referer header (optional)
 */
async function executeScrape(url, extractorJS, options = {}) {
  const {
    waitMs = 2000,
    timeoutMs = 30000,
    waitFor = null,
    scrollFirst = false,
    dismissCookies = true,
    referer = null,
  } = options;

  const domain = extractDomain(url);
  let page = null;

  try {
    // Per-domain rate limiting — wait for cooldown before proceeding
    // This runs BEFORE the timeout race so cooldown doesn't eat into scrape time
    await waitForDomainCooldown(domain);

    const result = await Promise.race([
      (async () => {
        page = await createStealthPage();

        // Set page-level timeout
        page.setDefaultNavigationTimeout(timeoutMs - 2000);

        // Set referrer organically if specified
        if (referer) {
          await page.evaluateOnNewDocument((ref) => {
            Object.defineProperty(document, 'referrer', { get: () => ref });
          }, referer);
        }

        // Navigate with network wait
        try {
          await page.goto(url, { waitUntil: 'networkidle2', timeout: timeoutMs - 5000 });
        } catch (e) {
          if (!e.message.includes('ERR_ABORTED') && !e.message.includes('net::ERR_')) {
            throw e;
          }
        }

        // Dismiss cookie/privacy banners
        if (dismissCookies) {
          await dismissCookieBanner(page);
        }

        // Wait for specific content selector if provided
        if (waitFor) {
          try {
            await page.waitForSelector(waitFor, { timeout: Math.min(waitMs + 3000, 8000) });
          } catch {
            // Selector didn't appear — continue anyway, extractor may still find content
          }
        }

        // Human-like behavior: mouse movement + scrolling
        if (scrollFirst) {
          await humanScroll(page, 3);
        } else {
          // Even without scrolling, do a quick mouse wiggle to look human
          await humanMouseMove(page);
        }

        // Extra settle time for JS-rendered content (add randomized jitter)
        if (waitMs > 0) {
          const jitteredWait = waitMs + Math.floor(Math.random() * 1000) - 500;
          await new Promise(r => setTimeout(r, Math.max(500, jitteredWait)));
        }

        // Execute the extractor in page context
        return await page.evaluate(extractorJS);
      })(),
      // Timeout starts AFTER cooldown — full budget for actual scraping
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Scrape timed out after ${timeoutMs}ms for ${url}`)), timeoutMs)
      ),
    ]);

    markDomainSuccess(domain);
    return result;
  } catch (error) {
    markDomainError(domain);
    throw error;
  } finally {
    if (page) {
      try { await page.close(); } catch { /* already closed */ }
    }
  }
}

/**
 * Queue a single scrape task. Respects MAX_CONCURRENT limit.
 * @param {string} url
 * @param {string} extractorJS — JS string to evaluate in page context
 * @param {object} [options] — { waitMs, timeoutMs, waitFor, scrollFirst, dismissCookies, referer }
 * @returns {Promise<any>}
 */
export function queueScrape(url, extractorJS, options = {}) {
  return new Promise((resolve, reject) => {
    queue.push({ url, extractorJS, options, resolve, reject });
    processQueue();
  });
}

/**
 * Queue multiple scrape tasks. All go through the concurrency limiter.
 * @param {Array<{id: string, url: string, extractorJS: string, options?: object}>} tasks
 * @returns {Promise<Array<{id: string, success: boolean, data?: any, error?: string}>>}
 */
export async function scrapeMultiple(tasks) {
  const results = await Promise.allSettled(
    tasks.map(async (task) => {
      const data = await queueScrape(task.url, task.extractorJS, task.options);
      return { id: task.id, success: true, data };
    })
  );

  return results.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    return { id: tasks[i].id, success: false, error: r.reason?.message || 'Unknown error' };
  });
}

// ── Tier 4 Escalation Tracking ──────────────────────────────────────────────
// Tracks success/failure history per domain to recommend Tier 4 escalation.
// If a domain fails ≥3 of its last 10 attempts, it's flagged for Tier 4.

const ESCALATION_THRESHOLD = 3;      // Failures out of last N attempts
const HISTORY_WINDOW = 10;            // Rolling window size

/** @type {Map<string, boolean[]>} domain → array of success (true) / failure (false) */
const domainHistory = new Map();

/** Record a success or failure for a domain's rolling window. */
function recordDomainAttempt(domain, success) {
  const history = domainHistory.get(domain) || [];
  history.push(success);
  // Keep only the last HISTORY_WINDOW entries
  if (history.length > HISTORY_WINDOW) history.shift();
  domainHistory.set(domain, history);
}

/**
 * Get health status for a domain — used by IPC layer to decide Tier 4 escalation.
 * @param {string} domain — e.g., 'glassdoor.com'
 * @returns {{ attempts: number, failures: number, successRate: number, shouldEscalate: boolean }}
 */
export function getDomainHealth(domain) {
  // Normalize: accept either 'glassdoor' or 'glassdoor.com'
  const normalizedDomain = domain.includes('.') ? domain : `${domain}.com`;
  
  // Find matching domain in history
  let matchedHistory = null;
  for (const [key, history] of domainHistory) {
    if (key.includes(normalizedDomain) || normalizedDomain.includes(key)) {
      matchedHistory = history;
      break;
    }
  }
  
  if (!matchedHistory || matchedHistory.length === 0) {
    return { attempts: 0, failures: 0, successRate: 1, shouldEscalate: false };
  }

  const failures = matchedHistory.filter(s => !s).length;
  const successRate = matchedHistory.length > 0 
    ? (matchedHistory.length - failures) / matchedHistory.length 
    : 1;

  return {
    attempts: matchedHistory.length,
    failures,
    successRate: Math.round(successRate * 100) / 100,
    shouldEscalate: failures >= ESCALATION_THRESHOLD,
  };
}

