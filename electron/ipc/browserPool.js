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
import { randomUUID } from 'crypto';
import { logger } from '../logger.js';

const MAX_CONCURRENT = 3;
const MAX_PER_DOMAIN = 1; // Only 1 concurrent page per domain

let activeCount = 0;
const activeDomains = new Map(); // domain -> count of active pages
const queue = [];
const activeTasks = new Map(); // cacheKey -> Promise (deduplicates both queued and running tasks)
const pageHandles = new Map(); // uuid -> { page, startTime }
let isShuttingDown = false;

// Domain-specific RPM policies (per deep research report, P6).
// LinkedIn is aggressively defended; StockX uses PerimeterX; eBay is moderate.
const DOMAIN_POLICIES = {
  'linkedin.com': { rpm: 1, baseCooldownMs: 60000 },   // ~1 req/min, daily cap
  'indeed.com': { rpm: 5, baseCooldownMs: 12000 },   // 5 req/min
  'glassdoor.com': { rpm: 3, baseCooldownMs: 20000 },   // Cloudflare-heavy
  'stockx.com': { rpm: 3, baseCooldownMs: 20000 },   // PerimeterX
  'ebay.com': { rpm: 15, baseCooldownMs: 4000 },   // Moderate tolerance
  'poshmark.com': { rpm: 5, baseCooldownMs: 12000 },
  'mercari.com': { rpm: 8, baseCooldownMs: 8000 },
  'reverb.com': { rpm: 10, baseCooldownMs: 6000 },
  'swappa.com': { rpm: 10, baseCooldownMs: 6000 },
  'depop.com': { rpm: 5, baseCooldownMs: 12000 },
};
const DEFAULT_POLICY = { rpm: 5, baseCooldownMs: 12000 };

// Pre-built entry list — avoids recreating the array on every getDomainPolicy call.
const DOMAIN_POLICY_ENTRIES = Object.entries(DOMAIN_POLICIES);

// ── Utility Functions ───────────────────────────────────────────────────────

/** Canonicalize a raw domain name against known policies */
function getCanonicalDomain(rawDomain) {
  for (const [key] of DOMAIN_POLICY_ENTRIES) {
    if (rawDomain.includes(key)) return key;
  }
  return rawDomain;
}

/** Returns the canonical policy key for a URL (e.g., 'ebay.com' even for 'm.ebay.com') */
function extractDomain(url) {
  try {
    const rawDomain = new URL(url).hostname.replace(/^www\./, '');
    return getCanonicalDomain(rawDomain);
  } catch {
    return 'unknown';
  }
}

/** Gaussian-distributed random delay (more natural than uniform). */
function gaussianDelay(mean, stddev) {
  // Clamp u1 away from 0: Math.log(0) = -Infinity → sqrt(-Infinity) = NaN →
  // Math.max(1000, NaN) = NaN in JS → setTimeout(fn, NaN) fires immediately,
  // bypassing the rate-limiter.  Number.EPSILON (~5e-324) is safe.
  const u1 = Math.random() || Number.EPSILON;
  const u2 = Math.random();
  const normal = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.max(1000, Math.round(mean + normal * stddev));
}

// ── Per-Domain Rate Limiter ─────────────────────────────────────────────────
const domainNextAllowed = new Map();
const domainBackoff = new Map();

function getDomainPolicy(domain) {
  return DOMAIN_POLICIES[domain] || DEFAULT_POLICY;
}

function isDomainCoolingDown(domain) {
  const next = domainNextAllowed.get(domain);
  return next ? Date.now() < next : false;
}

/** 
 * Updates the cooldown timer for a domain.
 * Called after each successful or failed request.
 */
function updateDomainCooldown(domain) {
  const backoffMult = domainBackoff.get(domain) || 1;
  const policy = getDomainPolicy(domain);
  const baseCooldown = gaussianDelay(policy.baseCooldownMs, policy.baseCooldownMs * 0.3);
  const cooldown = baseCooldown * backoffMult;
  
  domainNextAllowed.set(domain, Date.now() + cooldown);
}

/** Mark a domain as having encountered an error (triggers exponential backoff). */
function markDomainError(domain) {
  const current = domainBackoff.get(domain) || 1;
  const next = Math.min(current * 2, 16); // Max 16x = ~64s cooldown
  domainBackoff.set(domain, next);
  updateDomainCooldown(domain); // Trigger immediate cooldown on error
  
  // Record for Tier 4 escalation tracking
  recordDomainAttempt(domain, false);
}

/** Mark a domain as having succeeded (halves backoff). */
function markDomainSuccess(domain) {
  const current = domainBackoff.get(domain) || 1;
  if (current > 1) {
    domainBackoff.set(domain, Math.max(1, current * 0.5)); // Halve backoff on success
  }
  updateDomainCooldown(domain);
  // Record for Tier 4 escalation tracking
  recordDomainAttempt(domain, true);
}

function canProcessTask(task) {
  const domain = extractDomain(task.url);
  const domainActive = activeDomains.get(domain) || 0;
  // Per-domain concurrency limit AND per-domain cooldown check.
  // This allows processQueue to skip tasks that are still in cooldown
  // and process others, maximizing global slot utilization.
  return domainActive < MAX_PER_DOMAIN && !isDomainCoolingDown(domain);
}

let queuePoller = null;

function processQueue() {
  // If tasks are waiting and no active task is polling, ensure we periodically wake up
  if (queue.length > 0 && !queuePoller) {
    queuePoller = setInterval(() => {
      if (queue.length === 0) {
        clearInterval(queuePoller);
        queuePoller = null;
      } else {
        processQueue(); // Will do the actual dispatch
      }
    }, 1000);
  } else if (queue.length === 0 && queuePoller) {
    clearInterval(queuePoller);
    queuePoller = null;
  }

  while (activeCount < MAX_CONCURRENT && queue.length > 0) {
    // Find the first task whose domain isn’t at capacity
    const taskIdx = queue.findIndex(t => canProcessTask(t));
    if (taskIdx === -1) break; // All queued tasks are for busy domains

    const task = queue.splice(taskIdx, 1)[0];
    const { url, extractorJS, options, resolve, reject } = task;
    const domain = extractDomain(url);

    activeCount++;
    activeDomains.set(domain, (activeDomains.get(domain) || 0) + 1);

    executeScrape(url, extractorJS, options)
      .then(resolve)
      .catch((err) => {
        if (!isShuttingDown) reject(err);
      })
      .finally(() => {
        activeCount--;
        const count = activeDomains.get(domain) || 1;
        if (count <= 1) activeDomains.delete(domain);
        else activeDomains.set(domain, count - 1);
        
        // Schedule another check soon in case of domain cooldowns
        setTimeout(processQueue, 500); 
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
  const pageId = randomUUID(); // Track this specific page instance
  let page = null;
  let timeoutId = null;
  let isSettled = false;

  if (isShuttingDown) {
    throw new Error('Browser pool is shutting down');
  }

  try {
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(`Scrape timed out after ${timeoutMs}ms for ${url}`)), timeoutMs);
    });

    const scrapePromise = (async () => {
      let abortHandler = null;
      try {
        page = await createStealthPage();
        if (isShuttingDown || isSettled || options.signal?.aborted) {
          if (page) {
            await page.close().catch(() => {});
          }
          if (options.signal?.aborted) throw new Error('Aborted');
          return null;
        }
        pageHandles.set(pageId, { page, startTime: Date.now() });

        if (options.signal) {
          abortHandler = () => {
            if (page && !page.__closing) {
              page.__closing = true;
              page.close().catch(() => {});
            }
          };
          options.signal.addEventListener('abort', abortHandler, { once: true });
        }

        // If the outer operation already timed out before we got the page, abort.
        if (isSettled) {
          return null;
        }

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
          await page.goto(url, { waitUntil: options.waitUntil || 'networkidle2', timeout: timeoutMs - 5000 });
        } catch (e) {
          if (!e?.message?.includes('ERR_ABORTED') && !e?.message?.includes('net::ERR_') && !e?.message?.includes('TimeoutError') && !e?.message?.includes('timeout')) {
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
      } finally {
        if (options.signal && abortHandler) {
          options.signal.removeEventListener('abort', abortHandler);
        }
        isSettled = true; // Ensure inner settle happens even on errors
        pageHandles.delete(pageId);
        if (page && !page.__closing) {
          page.__closing = true;
          try {
            if (!page.isClosed()) {
              let closeTimeoutId;
              await Promise.race([
                page.close(),
                new Promise(r => { closeTimeoutId = setTimeout(r, 2000); })
              ]);
              if (closeTimeoutId) clearTimeout(closeTimeoutId);
            }
          } catch { /* already closed */ }
        }
      }
    })();

    // Prevent unhandled promise rejection if timeout wins and scrapePromise later rejects
    scrapePromise.catch(() => { });

    const result = await Promise.race([scrapePromise, timeoutPromise]);

    markDomainSuccess(domain);
    return result;
  } catch (error) {
    const isAborted = options.signal?.aborted || error?.message === 'Aborted' || isShuttingDown;
    
    if (isAborted) {
      logger.info(`[BrowserPool] Scrape aborted/shutting down for ${url}`);
    } else {
      logger.error(`[BrowserPool] Scrape failed for ${url}:`, error);
      markDomainError(domain);
    }
    
    // Clean up handle
    pageHandles.delete(pageId);

    // Safety: ensure no concurrent close calls
    if (page && !page.__closing) {
      page.__closing = true;
      try {
        if (!page.isClosed()) {
          let closeTimeoutId;
          await Promise.race([
            page.close(),
            new Promise(r => { closeTimeoutId = setTimeout(r, 2000); })
          ]);
          if (closeTimeoutId) clearTimeout(closeTimeoutId);
        }
      } catch (e) {
        logger.warn('[BrowserPool] Page close error:', e.message);
      }
    }
    throw error;
  } finally {
    isSettled = true;
    if (timeoutId) clearTimeout(timeoutId);
  }
}

// ── Process Exit Cleanup ────────────────────────────────────────────────────
/**
 * Forcefully close all active pages in the pool.
 * Called during application shutdown.
 */
export async function closeAllPages() {
  isShuttingDown = true;
  const handles = Array.from(pageHandles.values());
  pageHandles.clear();

  logger.info(`[BrowserPool] Closing ${handles.length} active pages during shutdown...`);

  await Promise.allSettled(handles.map(async ({ page }) => {
    try {
      if (page && !page.isClosed()) {
        // Use a race to avoid hanging the entire app shutdown if one page is stuck
        let shutdownTimeoutId;
        await Promise.race([
          page.close(),
          new Promise(r => { shutdownTimeoutId = setTimeout(r, 1000); })
        ]);
        if (shutdownTimeoutId) clearTimeout(shutdownTimeoutId);
      }
    } catch {
      // Ignored during shutdown
    }
  }));
}

// Backup cleanup for orphaned browsers or pages on crash/exit.
process.on('exit', () => {
  for (const { page } of pageHandles.values()) {
    try { 
      if (!page.isClosed()) {
        logger.info('[BrowserPool] Orphaned page detected on exit');
      }
    } catch { /* ignore */ }
  }
});

/**
 * Queue a single scrape task. Respects MAX_CONCURRENT limit.
 * @param {string} url
 * @param {string} extractorJS — JS string to evaluate in page context
 * @param {object} [options] — { waitMs, timeoutMs, waitFor, scrollFirst, dismissCookies, referer }
 * @returns {Promise<any>}
 */
export function queueScrape(url, extractorJS, options = {}) {
  // Deduplication: if an identical task is already processing (queued OR active), reuse its promise.
  const cacheKey = `${url}|${extractorJS}|${options.waitMs || 0}|${options.scrollFirst || false}`;
  
  if (activeTasks.has(cacheKey)) {
    return activeTasks.get(cacheKey);
  }

  let onAbort;
  const promise = new Promise((resolve, reject) => {
    if (options.signal?.aborted) return reject(new Error('Aborted'));
    
    if (options.signal) {
      onAbort = () => {
        const idx = queue.findIndex(t => t.resolve === resolve);
        if (idx !== -1) {
          queue.splice(idx, 1);
          reject(new Error('Aborted'));
        }
      };
      options.signal.addEventListener('abort', onAbort, { once: true });
    }

    // We intentionally don't handle chained resolves manually anymore,
    // since everyone shares this one root promise returned from the map!
    queue.push({ url, extractorJS, options, resolve, reject });
    processQueue();
  }).finally(() => {
    if (options.signal && onAbort) {
      options.signal.removeEventListener('abort', onAbort);
    }
    // Once settled (success or failure), remove from active map so future requests run fresh.
    activeTasks.delete(cacheKey);
  });

  activeTasks.set(cacheKey, promise);
  return promise;
}

/**
 * Queue multiple scrape tasks. All go through the concurrency limiter.
 * @param {Array<{id: string, url: string, extractorJS: string, options?: object}>} tasks
 * @returns {Promise<Array<{id: string, success: boolean, data?: any, error?: string}>>}
 */
export async function scrapeMultiple(tasks, onProgress = null, signal = null) {
  const results = await Promise.allSettled(
    tasks.map(async (task) => {
      try {
        if (signal?.aborted) throw new Error('Aborted');
        const data = await queueScrape(task.url, task.extractorJS, { ...task.options, signal });
        const result = { id: task.id, success: true, data };
        onProgress?.(result);
        return result;
      } catch (err) {
        const result = { id: task.id, success: false, error: err?.message || 'Unknown error' };
        onProgress?.(result);
        throw err;
      }
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
 * @param {string} domain — e.g., 'glassdoor.com' or 'glassdoor'
 * @returns {{ attempts: number, failures: number, successRate: number, shouldEscalate: boolean }}
 */
export function getDomainHealth(domain) {
  // Normalize: accept either 'glassdoor' or 'glassdoor.com'
  const normalizedDomain = domain.includes('.') ? domain : `${domain}.com`;

  // Find canonical key
  const canonicalKey = getCanonicalDomain(normalizedDomain);

  const matchedHistory = domainHistory.get(canonicalKey) ?? null;

  if (!matchedHistory || matchedHistory.length === 0) {
    return { attempts: 0, failures: 0, successRate: 1, shouldEscalate: false };
  }

  const failures = matchedHistory.filter(s => !s).length;
  const successRate = (matchedHistory.length - failures) / matchedHistory.length;

  return {
    attempts: matchedHistory.length,
    failures,
    successRate: Math.round(successRate * 100) / 100,
    shouldEscalate: failures >= ESCALATION_THRESHOLD,
  };
}
