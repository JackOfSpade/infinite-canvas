/**
 * Automated browser scraper for job sources.
 *
 * Opens ONE visible Puppeteer browser window and cycles through all browser-scraped
 * sources sequentially. Navigates programmatically, extracts automatically, and
 * paginates without user input.
 *
 * Only pauses if a bot challenge (CAPTCHA, Cloudflare, PerimeterX) is detected —
 * the overlay turns amber and prompts the user to solve it. Once real content
 * appears, automation resumes immediately.
 *
 * For all 5 sources, the scraper auto-clicks each job card to expand the full
 * description from the side panel (or modal, for Wellfound).
 *
 * Return shape mirrors scrapeMultiple:
 *   Array<{ id, sourceId, success, data, pagesWalked, stopReason, warning }>
 */

import puppeteer from 'puppeteer-extra';
import { closeStealthBrowser, getUserDataDir, findChromePath } from '../stealthBrowser.js';
import { logger } from '../../logger.js';
import { JOB_MAX_PAGES } from '../resultCaps.js';

// ── Timing ────────────────────────────────────────────────────────────────────
const NAV_SETTLE_MS          = 2000;          // settle after navigation before first action
const CONTENT_POLL_MS        = 600;           // poll interval while waiting for content/challenge
const CONTENT_TIMEOUT_MS     = 20_000;        // max wait for content before proceeding anyway
const CHALLENGE_TIMEOUT_MS   = 5 * 60_000;   // 5 min for user to solve challenge
const DESC_CHANGE_POLL_MS    = 200;           // poll interval waiting for description panel update
const DESC_CHANGE_TIMEOUT_MS = 3_000;         // max wait for description to change after a card click
const DESC_CLICK_DELAY_MS    = 600;           // pause between card clicks (natural pacing)
const SITE_CHANGED_ABORT_THRESHOLD = 3;
const DESC_STALE_THRESHOLD   = 3;             // consecutive click/panel failures before flagging stale selectors

// ── Per-source configs ────────────────────────────────────────────────────────
const SOURCE_LABELS = {
  google:       'Google Jobs',
  indeed:       'Indeed',
  ziprecruiter: 'ZipRecruiter',
  glassdoor:    'Glassdoor',
  wellfound:    'Wellfound',
};

// Selector confirming real page content is present (vs bot-challenge page).
// null = no reliable selector; skip content check, rely solely on challenge detection.
const CONTENT_SELECTORS = {
  google:       '.EimVGf, [jscontroller="b11o3b"]',
  indeed:       '.job_seen_beacon, .resultContent',
  ziprecruiter: null,   // JSON-LD tag exists on challenge pages too; extractor validates
  glassdoor:    '[data-test="jobListing"], .JobCard_jobCardWrapper',
  wellfound:    '[data-testid="job-listing-list"]',
};

// Selector for the "Next page" control (null = no auto-pagination for this source).
// These need validation in-browser — flag any that don't work.
const NEXT_PAGE_SELECTORS = {
  google:       null,
  indeed:       'a[data-testid="pagination-page-next"]',
  ziprecruiter: null,
  glassdoor:    'button[data-test="pagination-next"]',
  wellfound:    null,
};

// Per-source config for clicking cards to expand full job descriptions.
// null = source doesn't support card-click description expansion.
//
//   keyParam      — URL query param holding the job's unique key (mutually exclusive with keyRegex)
//   keyRegex      — regex string (1 capture group) to extract key from URL path instead of a param
//   keyDecode     — whether to decodeURIComponent the extracted key
//   cardAttr      — if set, find card via [cardAttr="{key}"] querySelector
//   cardIdPrefix  — if set (cardAttr/cardHrefKey null), find card via getElementById(prefix + key)
//   cardHrefKey   — if set (others null), find card via a[href*="{cardHrefKey}{key}-"]
//   clickSelector — element to click within the found card; null = click card itself
//   panelSelector — CSS selector for the description panel that updates after each click
//   panelMulti    — if true, querySelectorAll + join textContent (for split-element panels)
//   closeSelector — if set, click this after reading to close a modal before the next card
//   preScroll     — if true, scroll the page top-to-bottom before the click loop to force
//                   lazy-rendered cards into the DOM (needed when the extractor reads from
//                   embedded JSON but the React list only renders visible cards on demand)
const DESC_CONFIGS = {
  google: {
    keyParam:      'htidocid',
    keyRegex:      null,
    keyDecode:     true,
    cardAttr:      null,
    cardIdPrefix:  '',           // getElementById(key) = the [role="button"] clickable element
    cardHrefKey:   null,
    clickSelector: null,
    panelSelector: '.OOyDTc, .ejCXj',
    panelMulti:    true,         // description split across visible + hidden spans
    closeSelector: null,
    preScroll:     false,
  },
  indeed: {
    keyParam:      'jk',
    keyRegex:      null,
    keyDecode:     false,
    cardAttr:      'data-jk',   // data-jk is on the <a> link itself — click it directly
    cardIdPrefix:  null,
    cardHrefKey:   null,
    clickSelector: null,
    panelSelector: '#jobDescriptionText',
    panelMulti:    false,
    closeSelector: null,
    // Indeed's __NEXT_DATA__ extractor reads all jobs from JSON regardless of scroll
    // position; the React list lazy-renders cards on demand. Without pre-scrolling,
    // [data-jk="key"] returns null for cards below the initial viewport.
    preScroll:     true,
  },
  ziprecruiter: {
    keyParam:      'jid',
    keyRegex:      null,
    keyDecode:     false,
    cardAttr:      null,
    cardIdPrefix:  'job-card-',  // <article id="job-card-{jid}">
    cardHrefKey:   null,
    clickSelector: 'button[aria-label^="View "]',
    panelSelector: '[data-testid="job-details-scroll-container"] .whitespace-pre-line',
    panelMulti:    false,
    closeSelector: null,
    preScroll:     false,
  },
  glassdoor: {
    keyParam:      'jl',
    keyRegex:      null,
    keyDecode:     false,
    cardAttr:      'data-jobid',  // <li data-jobid="...">; jl param in URL matches this ID
    cardIdPrefix:  null,
    cardHrefKey:   null,
    clickSelector: null,          // click the <li> itself — React handler loads right panel
    panelSelector: '[data-brandviews*="joblisting-description"]',
    panelMulti:    false,
    closeSelector: null,
    preScroll:     false,
  },
  wellfound: {
    keyParam:      null,
    keyRegex:      '/jobs/(\\d+)-',  // job ID from path: /jobs/4238742-slug
    keyDecode:     false,
    cardAttr:      null,
    cardIdPrefix:  null,
    cardHrefKey:   '/jobs/',          // find: a[href*="/jobs/{key}-"]
    clickSelector: null,              // click the <a> job link directly (React intercepts → modal)
    panelSelector: '#job-description',
    panelMulti:    false,
    closeSelector: '[data-test="closeButton"]',
    preScroll:     false,
  },
};

// ── Challenge detection ───────────────────────────────────────────────────────
async function detectChallengePage(page) {
  return page.evaluate(() => {
    if (document.querySelector('#challenge-form, #cf-challenge-running')) return true;
    if (/^just a moment/i.test(document.title || '')) return true;
    if (document.querySelector('#px-captcha, #px-block-page-container')) return true;
    if (document.querySelector('iframe[src*="recaptcha/api2"], iframe[src*="recaptcha/enterprise"]')) return true;
    if (document.querySelector('iframe[src*="hcaptcha.com"]')) return true;
    if (document.querySelector('iframe[src*="challenges.cloudflare.com"]')) return true;
    return false;
  }).catch(() => false);
}

// ── Overlay ───────────────────────────────────────────────────────────────────
// Injected via evaluateOnNewDocument (runs before site JS on every new document)
// AND via an immediate page.evaluate after each URL navigation.
//
// State fields (filled by updateOverlay):
//   srcLabel, srcName, qLabel, qText — source/query identity
//   count — job count (integer)
//   status — current action text
//   challenge — boolean, turns dot amber
//   error — boolean, turns dot red and disables skip
//
// The "Skip source" button sets window.__icCmd = 'skip'; the Node.js loop reads it.
const OVERLAY_SCRIPT = `(function(){
  if(document.getElementById('__ic-panel')) return;
  window.__icCmd = null;
  const sty = document.createElement('style');
  sty.textContent = [
    '@keyframes ic-blink{0%,100%{opacity:1}50%{opacity:.35}}',
    '@keyframes ic-pulse{0%,100%{opacity:1}50%{opacity:.45}}',
    '#__ic-panel button:hover:not(:disabled){filter:brightness(1.2)}',
    '#__ic-panel button:disabled{opacity:.4;cursor:default}',
  ].join('');
  (document.head||document.documentElement).appendChild(sty);

  const el = document.createElement('div');
  el.id = '__ic-panel';
  el.style.cssText = [
    'position:fixed;bottom:20px;right:20px;z-index:2147483647',
    'background:#0f172a;color:#e2e8f0;border-radius:14px',
    'padding:18px 20px;width:272px',
    'font:13px/1.5 system-ui,-apple-system,sans-serif',
    'box-shadow:0 16px 48px rgba(0,0,0,.8);border:1px solid rgba(255,255,255,.1)',
    'pointer-events:auto',
  ].join(';');

  el.innerHTML = [
    '<div style="display:flex;align-items:center;gap:7px;margin-bottom:9px">',
      '<div id="ic-dot" style="width:9px;height:9px;border-radius:50%;background:#4ade80;',
        'animation:ic-blink 1.4s ease-in-out infinite;flex-shrink:0"></div>',
      '<b style="font-size:13px;letter-spacing:-.2px">Job Collector</b>',
    '</div>',
    '<div id="ic-src-label" style="font-size:11px;color:#475569;margin-bottom:1px"></div>',
    '<div id="ic-src-name" style="font-weight:700;font-size:16px;margin-bottom:3px;',
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis"></div>',
    '<div id="ic-q-label" style="font-size:11px;color:#64748b;margin-bottom:2px"></div>',
    '<div id="ic-q-text" style="font-size:12px;color:#94a3b8;white-space:nowrap;overflow:hidden;',
      'text-overflow:ellipsis;margin-bottom:11px"></div>',
    '<div style="display:flex;align-items:baseline;gap:6px;margin-bottom:4px">',
      '<span id="ic-count" style="font-size:32px;font-weight:800;line-height:1;color:#f8fafc">0</span>',
      '<span style="font-size:12px;color:#64748b">jobs collected</span>',
    '</div>',
    '<div id="ic-status" style="font-size:11px;color:#64748b;margin-bottom:14px;min-height:16px;',
      'line-height:1.55"></div>',
    '<button id="ic-skip" style="width:100%;padding:7px 10px;background:rgba(255,255,255,.06);',
      'color:#64748b;border:1px solid rgba(255,255,255,.09);border-radius:7px;',
      'cursor:pointer;font:500 12px system-ui;transition:filter .15s">Skip source</button>',
  ].join('');

  el.querySelector('#ic-skip').addEventListener('click', function(){
    if(this.disabled) return;
    this.disabled = true; this.textContent = 'Skipping…';
    window.__icCmd = 'skip';
  });

  const attach = () => {
    if(document.body && !document.getElementById('__ic-panel')) document.body.appendChild(el);
  };
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', attach);
  else attach();
})()`;

async function injectOverlay(page) {
  await page.evaluate(OVERLAY_SCRIPT).catch(() => {});
}

async function updateOverlay(page, state) {
  await page.evaluate((s) => {
    const p = document.getElementById('__ic-panel');
    if (!p) return;
    const g   = id => p.querySelector('#' + id);
    const set = (id, v) => { const e = g(id); if (e && v != null) e.textContent = v; };

    set('ic-src-label', s.srcLabel);
    set('ic-src-name',  s.srcName);
    set('ic-q-label',   s.qLabel);
    set('ic-q-text',    s.qText);
    if (s.count != null) set('ic-count', s.count);
    set('ic-status',    s.status ?? '');

    const dot = g('ic-dot');
    if (dot) {
      if (s.error) {
        dot.style.background = '#ef4444';
        dot.style.animation  = 'none';
      } else if (s.challenge) {
        dot.style.background = '#f59e0b';
        dot.style.animation  = 'ic-pulse 1s ease-in-out infinite';
      } else {
        dot.style.background = '#4ade80';
        dot.style.animation  = 'ic-blink 1.4s ease-in-out infinite';
      }
    }

    const skip = g('ic-skip');
    if (skip && !skip.disabled) {
      if (s.challenge) {
        skip.textContent = 'Skip source';
        skip.style.color = '#94a3b8';
      }
    }
    if (s.error && skip) {
      skip.disabled    = true;
      skip.textContent = '—';
    }
  }, state).catch(() => {});
}

async function readCmd(page) {
  return page.evaluate(() => {
    const c = window.__icCmd;
    if (c) window.__icCmd = null;
    return c || null;
  }).catch(() => null);
}

// ── waitForReady ──────────────────────────────────────────────────────────────
// Waits for real page content to appear, handling challenge pages.
// Returns 'ok' | 'skip' (user skipped) | 'abort' (signal / unrecoverable).
async function waitForReady(page, sourceId, overlayBase, signal) {
  const contentSel    = CONTENT_SELECTORS[sourceId];
  const contentDL     = Date.now() + CONTENT_TIMEOUT_MS;
  let inChallenge     = false;
  let challengeDL     = 0;

  while (true) {
    if (signal?.aborted) return 'abort';

    const cmd = await readCmd(page);
    if (cmd === 'skip') return 'skip';

    const isChallenge = await detectChallengePage(page);
    const hasContent  = !contentSel || await page.evaluate(
      s => !!document.querySelector(s), contentSel
    ).catch(() => false);

    if (isChallenge && !hasContent) {
      if (!inChallenge) {
        inChallenge = true;
        challengeDL = Date.now() + CHALLENGE_TIMEOUT_MS;
        await updateOverlay(page, {
          ...overlayBase,
          status:    '⚠️ Complete the challenge above to continue',
          challenge: true,
        });
        logger.info(`[BrowserScraper] ${overlayBase.srcName}: bot challenge detected — waiting for user`);
      }
      if (Date.now() > challengeDL) {
        logger.warn(`[BrowserScraper] ${overlayBase.srcName}: challenge not solved within timeout — skipping source`);
        return 'skip';
      }
      await new Promise(r => setTimeout(r, CONTENT_POLL_MS));
      continue;
    }

    if (inChallenge) {
      // Challenge just cleared — let the page finish rendering
      await new Promise(r => setTimeout(r, 1000));
      await updateOverlay(page, { ...overlayBase, status: 'Extracting jobs…' });
      logger.info(`[BrowserScraper] ${overlayBase.srcName}: challenge resolved — resuming`);
      return 'ok';
    }

    if (hasContent || Date.now() > contentDL) return 'ok';

    await new Promise(r => setTimeout(r, CONTENT_POLL_MS));
  }
}

// ── Extractor runner ──────────────────────────────────────────────────────────
// Returns { jobs: Array, siteChangedError: Error|null }.
async function runExtractor(page, extractorJS) {
  try {
    const raw = await page.evaluate(extractorJS);
    return { jobs: Array.isArray(raw) ? raw : [], siteChangedError: null };
  } catch (err) {
    if (/SITE_CHANGED/i.test(err?.message)) return { jobs: [], siteChangedError: err };
    return { jobs: [], siteChangedError: null }; // context destroyed / transient — retry next tick
  }
}

// ── Description expansion ─────────────────────────────────────────────────────
// Clicks each job card and captures the full description from the side panel.
// Only runs when DESC_CONFIGS[sourceId] is defined.
//
// Returns { jobs, descError } where descError is non-null when card or panel
// selectors appear stale (≥ DESC_STALE_THRESHOLD consecutive failures of the same
// type). A non-null descError is an abort signal — the caller must set earlyExit
// and surface the error just like a SITE_CHANGED extraction failure.
async function expandDescriptions(page, jobs, sourceId, overlayBase, totalSoFar) {
  const cfg = DESC_CONFIGS[sourceId];
  if (!cfg || jobs.length === 0) return { jobs, descError: null };

  const enhanced = [...jobs];

  // Pre-scroll: trigger lazy rendering of all cards before the click loop.
  // Needed when the extractor reads all jobs from embedded JSON (e.g. __NEXT_DATA__)
  // but the React list only renders visible cards on demand. Without this, cards
  // below the initial viewport don't have DOM elements yet, and querySelector returns
  // null even though the job data was successfully extracted.
  if (cfg.preScroll) {
    // Scroll through the page using rAF so the browser gets a render frame between
    // each step — necessary for React virtual lists to mount off-screen cards.
    await page.evaluate(() => new Promise(resolve => {
      const STEP = 600;
      let y = 0;
      function tick() {
        window.scrollTo(0, y);
        y += STEP;
        if (y < document.documentElement.scrollHeight) {
          requestAnimationFrame(tick);
        } else {
          window.scrollTo(0, 0);
          resolve();
        }
      }
      requestAnimationFrame(tick);
    })).catch(() => {});
    await new Promise(r => setTimeout(r, 600));
  }

  // Start from empty so the first card's already-visible description is captured
  // on the first click rather than mistaken for "no change" and skipped.
  let prevPanelText = '';
  let consecutiveClickFails    = 0;
  let consecutivePanelTimeouts = 0;
  let descError = null;

  const abortWithError = async (evidence, suggestion) => {
    logger.warn(`[BrowserScraper] ${sourceId}: ${evidence}`);
    await updateOverlay(page, {
      ...overlayBase,
      count:  totalSoFar,
      status: 'Desc selector broken — fix selector code and restart.',
      error:  true,
    }).catch(() => {});
    await new Promise(r => setTimeout(r, 3000));
    descError = {
      code:       'stale-desc-selectors',
      severity:   'block',
      evidence,
      suggestion,
    };
  };

  for (let i = 0; i < enhanced.length; i++) {
    const job = enhanced[i];

    const rawKey = cfg.keyRegex
      ? job.url?.match(new RegExp(cfg.keyRegex))?.[1]
      : job.url?.match(new RegExp(`[?&]${cfg.keyParam}=([^&]+)`))?.[1];
    if (!rawKey) continue;
    const key = cfg.keyDecode ? decodeURIComponent(rawKey) : rawKey;

    await updateOverlay(page, {
      ...overlayBase,
      count:  totalSoFar,
      status: `Expanding descriptions… ${i + 1}/${enhanced.length}`,
    });

    try {
      const clicked = await page.evaluate((cardAttr, cardIdPrefix, cardHrefKey, clickSel, key) => {
        let card;
        if (cardAttr) {
          card = document.querySelector(`[${cardAttr}="${key}"]`);
          // Fallback: find an <a> whose href contains the key — handles cases where
          // the DOM attribute value doesn't match the URL key (e.g. Indeed sponsored
          // jobs where data-jk uses the canonical key but the stored URL has a
          // session/impression tracking variant of the key).
          if (!card) card = document.querySelector(`a[href*="${key}"]`);
        } else if (cardHrefKey !== null && cardHrefKey !== undefined) {
          card = document.querySelector(`a[href*="${cardHrefKey}${key}-"]`);
        } else {
          card = document.getElementById((cardIdPrefix || '') + key);
        }
        if (!card) return false;
        const target = clickSel ? card.querySelector(clickSel) : card;
        if (!target) return false;
        target.scrollIntoView({ block: 'nearest', behavior: 'instant' });
        target.click();
        return true;
      }, cfg.cardAttr, cfg.cardIdPrefix, cfg.cardHrefKey ?? null, cfg.clickSelector, key);

      if (!clicked) {
        consecutiveClickFails++;
        consecutivePanelTimeouts = 0;
        if (consecutiveClickFails >= DESC_STALE_THRESHOLD) {
          await abortWithError(
            `${consecutiveClickFails} consecutive card-click failures for ${sourceId} — card element not found in DOM (key="${key}")`,
            `The card selector for ${sourceId} description expansion may have changed. Check DESC_CONFIGS['${sourceId}'] cardAttr/cardIdPrefix/cardHrefKey in electron/ipc/browser/manualScraper.js.`,
          );
          break;
        }
        continue;
      }

      consecutiveClickFails = 0;

      let gotDescription = false;
      const dl = Date.now() + DESC_CHANGE_TIMEOUT_MS;
      while (Date.now() < dl) {
        await new Promise(r => setTimeout(r, DESC_CHANGE_POLL_MS));
        const text = await page.evaluate((panelSel, panelMulti) => {
          if (panelMulti) {
            return Array.from(document.querySelectorAll(panelSel))
              .map(e => e.textContent?.trim()).filter(Boolean).join('\n\n').trim();
          }
          return document.querySelector(panelSel)?.innerText?.trim() || '';
        }, cfg.panelSelector, cfg.panelMulti || false).catch(() => '');
        if (text && text !== prevPanelText) {
          enhanced[i] = { ...job, snippet: text };
          prevPanelText = text;
          gotDescription = true;
          break;
        }
      }

      if (gotDescription) {
        consecutivePanelTimeouts = 0;
      } else {
        consecutivePanelTimeouts++;
        if (consecutivePanelTimeouts >= DESC_STALE_THRESHOLD) {
          // Try to close any open modal before aborting so the page is left clean
          if (cfg.closeSelector) {
            await page.evaluate(sel => { document.querySelector(sel)?.click(); }, cfg.closeSelector).catch(() => {});
            await new Promise(r => setTimeout(r, 400));
          }
          await abortWithError(
            `${consecutivePanelTimeouts} consecutive panel-read timeouts for ${sourceId} — panel selector matched nothing or click no longer triggers panel update`,
            `Check DESC_CONFIGS['${sourceId}'] panelSelector (and clickSelector) in electron/ipc/browser/manualScraper.js.`,
          );
          break;
        }
      }

      // Close modal if source uses one (e.g. Wellfound), then reset so next card captures fresh
      if (cfg.closeSelector) {
        await page.evaluate((sel) => {
          document.querySelector(sel)?.click();
        }, cfg.closeSelector).catch(() => {});
        await new Promise(r => setTimeout(r, 400));
        prevPanelText = '';
      }
    } catch { /* page context destroyed or other transient error — not a stale-selector signal */ }

    if (page.isClosed()) break;
    await new Promise(r => setTimeout(r, DESC_CLICK_DELAY_MS));
  }

  return { jobs: enhanced, descError };
}

// ── Next-page clicker ─────────────────────────────────────────────────────────
// Returns true if next page was clicked and navigation started, false otherwise.
async function clickNextPage(page, sourceId) {
  const sel = NEXT_PAGE_SELECTORS[sourceId];
  if (!sel) return false;
  try {
    const clicked = await page.evaluate((s) => {
      const btn = document.querySelector(s);
      if (!btn || btn.disabled || btn.getAttribute('aria-disabled') === 'true') return false;
      btn.click();
      return true;
    }, sel);
    return clicked;
  } catch {
    return false;
  }
}

// ── Main export ───────────────────────────────────────────────────────────────
/**
 * Replace scrapeMultiple for the 5 browser-scraped sources with a fully
 * automated visible-browser session. Takes the same flat task array and
 * onResult callback; returns the same result array shape.
 *
 * @param {Array<{id, sourceId, url, extractorJS, query}>} tasks
 * @param {function} onResult  — called with {id, sourceId, success, data, ...} per source
 * @param {AbortSignal|null}   signal
 * @returns {Promise<Array>}
 */
export async function scrapeManualSources(tasks, onResult, signal) {
  // Group flat task list by sourceId, preserving declaration order
  const bySource = new Map();
  for (const task of tasks) {
    if (!bySource.has(task.sourceId)) bySource.set(task.sourceId, []);
    bySource.get(task.sourceId).push(task);
  }

  const results       = [];
  const executablePath = process.env.CHROME_PATH || await findChromePath();

  await closeStealthBrowser();

  const browser = await puppeteer.launch({
    headless: false,
    executablePath,
    userDataDir: await getUserDataDir(),
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--window-size=1280,900',
      '--lang=en-US,en',
    ],
    defaultViewport: null,
    ignoreHTTPSErrors: true,
  });

  const pages = await browser.pages();
  const page  = pages[0] || await browser.newPage();

  // Inject overlay on every new document so it survives navigations
  await page.evaluateOnNewDocument(OVERLAY_SCRIPT);

  let earlyExit    = false;
  let browserClosed = false;
  browser.on('disconnected', () => { browserClosed = true; earlyExit = true; });

  const sourceList = [...bySource.entries()];

  try {
    for (let si = 0; si < sourceList.length; si++) {
      if (earlyExit || signal?.aborted) break;

      const [sourceId, sourceTasks] = sourceList[si];
      const srcName  = SOURCE_LABELS[sourceId] || sourceId;
      const allJobs  = [];
      const seen     = new Set();
      let sourceSiteChangedWarning = null;
      let sourcePagesWalked        = 0;
      let sourceSkipped            = false; // user clicked "Skip source" for THIS source only

      logger.info(`[BrowserScraper] Starting ${si + 1}/${sourceList.length}: ${srcName} (${sourceTasks.length} queries)`);

      for (let qi = 0; qi < sourceTasks.length; qi++) {
        if (earlyExit || sourceSkipped || signal?.aborted) break;

        const task = sourceTasks[qi];

        const overlayBase = {
          srcLabel: `Source ${si + 1} of ${sourceList.length}`,
          srcName,
          qLabel:   `Query ${qi + 1} of ${sourceTasks.length}`,
          qText:    task.query || '',
        };

        logger.info(`[BrowserScraper] ${srcName} query ${qi + 1}/${sourceTasks.length}: ${task.url}`);

        // Navigate via window.location.href — avoids CDP Page.navigate fingerprint
        await page.evaluate(u => { window.location.href = u; }, task.url).catch(() => {});
        await new Promise(r => setTimeout(r, NAV_SETTLE_MS));

        await injectOverlay(page);
        await updateOverlay(page, { ...overlayBase, count: allJobs.length, status: 'Loading…' });

        // Wait for real content — handles challenge pages
        const readyState = await waitForReady(page, sourceId, overlayBase, signal);
        if (readyState === 'abort' || signal?.aborted) { earlyExit = true; break; }
        if (readyState === 'skip') {
          logger.info(`[BrowserScraper] ${srcName}: skipped by user`);
          sourceSkipped = true;
          break;
        }

        await injectOverlay(page); // re-inject after challenge resolution may have navigated
        await updateOverlay(page, { ...overlayBase, count: allJobs.length, status: 'Extracting jobs…' });

        // ── Per-query extraction + pagination loop ──────────────────────────
        let pageNum          = 1;
        let siteChangedStreak = 0;
        let siteChangedWarning = null;

        while (pageNum <= JOB_MAX_PAGES && !earlyExit && !sourceSkipped && !signal?.aborted) {
          const cmd = await readCmd(page);
          if (cmd === 'skip') { sourceSkipped = true; break; }

          await updateOverlay(page, {
            ...overlayBase,
            count:  allJobs.length,
            status: pageNum > 1 ? `Extracting page ${pageNum}…` : 'Extracting jobs…',
          });

          const { jobs: extracted, siteChangedError } = await runExtractor(page, task.extractorJS);

          if (siteChangedError) {
            siteChangedStreak++;
            logger.warn(`[BrowserScraper] ${srcName} SITE_CHANGED (${siteChangedStreak}/${SITE_CHANGED_ABORT_THRESHOLD}): ${siteChangedError.message}`);

            if (siteChangedStreak >= SITE_CHANGED_ABORT_THRESHOLD) {
              siteChangedWarning = {
                code:       'stale-selectors',
                severity:   'block',
                evidence:   siteChangedError.message.slice(0, 280),
                suggestion: `The ${srcName} extractor failed ${SITE_CHANGED_ABORT_THRESHOLD} times in a row — the site structure likely changed. Update the extractor in electron/extractors/jobs.js, rebuild, and try again.`,
              };
              await updateOverlay(page, {
                ...overlayBase,
                count:  allJobs.length,
                status: 'Extractor broken — site structure changed. Fix selector code and restart.',
                error:  true,
              }).catch(() => {});
              await new Promise(r => setTimeout(r, 3000));
              earlyExit = true;
              break;
            }
            // Below threshold — might be mid-load; don't paginate, retry next iteration
            await new Promise(r => setTimeout(r, 1000));
            continue;
          }

          siteChangedStreak = 0;

          // Deduplicate and accumulate page results
          const newJobs = [];
          for (const job of extracted) {
            const key = `${job.title}|${job.company}|${job.url || ''}`;
            if (!seen.has(key)) { seen.add(key); newJobs.push(job); }
          }

          // Expand descriptions for this page's new jobs (all 5 sources)
          const { jobs: enhanced, descError } = await expandDescriptions(page, newJobs, sourceId, overlayBase, allJobs.length + newJobs.length);
          allJobs.push(...enhanced);

          if (descError) {
            if (!sourceSiteChangedWarning) sourceSiteChangedWarning = descError;
            earlyExit = true;
            break;
          }

          await updateOverlay(page, {
            ...overlayBase,
            count:  allJobs.length,
            status: pageNum < JOB_MAX_PAGES ? 'Looking for next page…' : 'Page cap reached.',
          });

          logger.info(`[BrowserScraper] ${srcName} page ${pageNum}: ${newJobs.length} new jobs (${allJobs.length} total)`);

          // Try to paginate
          if (pageNum >= JOB_MAX_PAGES) break;
          const didPage = await clickNextPage(page, sourceId);
          if (!didPage) break;

          pageNum++;
          await new Promise(r => setTimeout(r, NAV_SETTLE_MS));
          await injectOverlay(page);
          await updateOverlay(page, { ...overlayBase, count: allJobs.length, status: `Loading page ${pageNum}…` });

          // Wait for new content to appear on the paginated page
          const pagedReady = await waitForReady(page, sourceId, overlayBase, signal);
          if (pagedReady === 'abort' || signal?.aborted) { earlyExit = true; break; }
          if (pagedReady === 'skip') { sourceSkipped = true; break; }
        }

        if (siteChangedWarning && !sourceSiteChangedWarning) {
          sourceSiteChangedWarning = siteChangedWarning;
        }
        sourcePagesWalked = Math.max(sourcePagesWalked, pageNum);
      }

      const result = {
        id:          `${sourceId}-0`,
        sourceId,
        success:     true,
        data:        allJobs,
        pagesWalked: sourcePagesWalked,
        stopReason:  earlyExit ? 'user-done' : 'completed',
        warning:     sourceSiteChangedWarning || null,
      };
      results.push(result);
      onResult?.(result);

      logger.info(`[BrowserScraper] ${srcName} done: ${allJobs.length} jobs`);
    }
  } finally {
    if (!browserClosed) await browser.close().catch(() => {});
  }

  // Emit empty results for sources we never reached
  for (const [sourceId] of bySource) {
    if (!results.some(r => r.sourceId === sourceId)) {
      const result = {
        id: `${sourceId}-0`, sourceId, success: true,
        data: [], pagesWalked: 0, stopReason: 'skipped', warning: null,
      };
      results.push(result);
      onResult?.(result);
    }
  }

  return results;
}
