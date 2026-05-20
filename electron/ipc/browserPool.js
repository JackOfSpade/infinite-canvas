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

/** 
 * Gracefully close a puppeteer page with a timeout to prevent hanging.
 */
async function safeClose(page, timeoutMs = 2000) {
  if (!page || page.isClosed() || page.__closing) return;
  page.__closing = true;
  let closeTimeoutId;
  try {
    await Promise.race([
      page.close(),
      new Promise(r => { closeTimeoutId = setTimeout(r, timeoutMs); })
    ]);
  } catch (e) {
    logger.warn('[BrowserPool] safeClose error:', e?.message || e);
  } finally {
    if (closeTimeoutId) clearTimeout(closeTimeoutId);
  }
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

  const scrapeStart = Date.now();
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
            safeClose(page, 2000);
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

        // Navigate. Default to 'domcontentloaded' rather than 'networkidle2':
        // ad/tracking-heavy result pages (e.g. eBay sold listings) never reach
        // network-idle, so networkidle2 burned the entire timeout budget and
        // tripped the outer hard timeout. We instead get the DOM fast and let
        // the extractor-stabilization loop below decide when results are ready
        // — a far better readiness signal than "the network went quiet." Still
        // capture the Response for anti-bot detection (status / final URL); if
        // navigation fails we keep going so the extractor gets a shot.
        let pageResponse = null;
        try {
          pageResponse = await page.goto(url, { waitUntil: options.waitUntil || 'domcontentloaded', timeout: timeoutMs - 5000 });
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

        // ── Dynamic content readiness ───────────────────────────────────────
        // Replaces the old "fixed settle delay → single extract." Poll the
        // extractor and wait for its item COUNT to stabilize: a server-rendered
        // page is ready on the first read; a JS/lazy grid is waited on exactly
        // as long as items keep arriving, then stops. This is what makes the
        // lighter 'domcontentloaded' navigation safe, and it removes the
        // guess-a-settle-time magic number. Bounded by the remaining timeout
        // budget (with headroom for anti-bot detection + close) and by a short
        // zero-streak so a genuinely-empty page returns promptly.
        const countItems = (r) => Array.isArray(r)
          ? r.length
          : (r && typeof r === 'object' && Array.isArray(r.items) ? r.items.length : (r ? -1 : 0));
        // -1 = an opaque (non-array, non-{items}) shape we can't count → accept on sight.
        const READINESS_POLL_MS = 600;
        const STABLE_READS_REQUIRED = 2;   // count unchanged this many reads → settled
        const MAX_ZERO_READS = 6;          // ~3.6s of 0 items → accept empty
        const readinessDeadline = scrapeStart + timeoutMs - 6000; // leave headroom

        // One short human-like beat before the first read (replaces the old
        // jittered settle), capped so it never dominates the budget.
        await new Promise(r => setTimeout(r, Math.max(300, Math.min(waitMs, 1200))));

        let extractorResult = null;
        let lastCount = -2;   // sentinel so the first real read always "changes"
        let stableReads = 0;
        let zeroReads = 0;
        while (true) {
          if (isSettled || options.signal?.aborted) break;
          let r = null;
          try { r = await page.evaluate(extractorJS); }
          catch { /* navigated mid-evaluate — retry next tick */ }
          if (r != null) {
            extractorResult = r;                 // always keep the freshest result
            const count = countItems(r);
            if (count === -1) break;             // opaque shape — done
            if (count > 0) {
              zeroReads = 0;
              if (count === lastCount) { if (++stableReads >= STABLE_READS_REQUIRED) break; }
              else { stableReads = 0; lastCount = count; }
            } else if (++zeroReads >= MAX_ZERO_READS) {
              break;                             // genuinely empty (or unparseable)
            }
          }
          if (Date.now() >= readinessDeadline) break;  // budget spent — take freshest
          await new Promise(res => setTimeout(res, READINESS_POLL_MS));
        }
        // Guarantee a value even if every evaluate threw (rare).
        if (extractorResult == null) {
          try { extractorResult = await page.evaluate(extractorJS); } catch { extractorResult = []; }
        }

        // Run anti-bot detection on what we observed. Both the raw extractor
        // result and the warning (if any) flow back to the caller so the UI can
        // render a visible signal instead of silently accepting a blocked page.
        let warning = null;
        try {
          const { detectAntiBotSignal } = await import('./antiBotDetector.js');
          const html       = await page.content().catch(() => '');
          const finalUrl   = page.url() || url;
          const status     = pageResponse?.status?.() ?? 0;
          const itemCount  = Array.isArray(extractorResult)
            ? extractorResult.length
            : (extractorResult && typeof extractorResult === 'object'
                ? (Array.isArray(extractorResult.items) ? extractorResult.items.length : null)
                : null);
          warning = detectAntiBotSignal({
            status,
            finalUrl,
            html,
            itemsExtracted: itemCount,
            expectedMinItems: options.expectedMinItems || 0,
            sourceLabel: options.sourceLabel || domain,
          });
          if (warning) {
            logger.warn(`[BrowserPool] Anti-bot signal on ${url}: ${warning.code} — ${warning.evidence}`);
          }
        } catch (e) {
          logger.warn('[BrowserPool] Anti-bot detector failed (non-fatal):', e?.message || String(e));
        }
        return { data: extractorResult, warning };
      } finally {
        if (options.signal && abortHandler) {
          options.signal.removeEventListener('abort', abortHandler);
        }
        isSettled = true; // Ensure inner settle happens even on errors
        pageHandles.delete(pageId);
        await safeClose(page, 2000);
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
    await safeClose(page, 2000);
    
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
  if (queuePoller) {
    clearInterval(queuePoller);
    queuePoller = null;
  }
  const handles = Array.from(pageHandles.values());
  pageHandles.clear();

  logger.info(`[BrowserPool] Closing ${handles.length} active pages during shutdown...`);

  await Promise.allSettled(handles.map(async ({ page }) => {
    await safeClose(page, 1000);
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
 * @returns {Promise<Array<{id: string, success: boolean, data?: any, warning?: object, error?: string}>>}
 *
 * Each result now carries an optional `warning` from antiBotDetector — surfaced
 * up the stack via the onProgress callback and the final return so callers
 * can show "this source was likely blocked/throttled" instead of silently
 * accepting an empty extractor result.
 */
export async function scrapeMultiple(tasks, onProgress = null, signal = null) {
  const results = await Promise.allSettled(
    tasks.map(async (task) => {
      try {
        if (signal?.aborted) throw new Error('Aborted');
        // executeScrape/queueScrape now return { data, warning }; preserve
        // both on the per-task result.
        const wrapped = await queueScrape(task.url, task.extractorJS, { ...task.options, signal, sourceLabel: task.id });
        const data = wrapped?.data ?? null;
        const warning = wrapped?.warning ?? null;
        const result = { id: task.id, success: true, data, warning };
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
