import { getSessionProfile } from './antiDetectProfiles.js';

/**
 * Human-emulation tuning. Movement amounts are FRACTIONS of the live viewport
 * (and, for scrolling, the page's content height) rather than absolute pixels,
 * so it looks natural on a 1440×900 or 1920×1080 screen alike. Timings/jitter
 * are then scaled by a per-SESSION behavior profile (speed/jitter/scrollDepth —
 * see antiDetectProfiles) so the cadence isn't byte-identical run to run.
 */
const EDGE_MARGIN_FRAC = 0.05; // keep movement off the very edge of the viewport

const MOUSE = {
  START_X_FRAC: 0.5,        // start somewhere in the left ~half …
  START_Y_FRAC: 0.33,       // … upper third
  DX_FRAC: 0.25,            // horizontal travel jitter, ±this × viewport width
  DY_MIN_FRAC: 0.18,        // vertical travel: at least this …
  DY_RANGE_FRAC: 0.28,      // … plus up to this × viewport height
  CP_X_FRAC: 0.12,          // bézier control-point wobble, ±this × width
  CP_Y_FRAC: 0.10,          // … × height
  STEPS_MIN: 15,
  STEPS_JITTER: 10,
  STEP_DELAY_MIN_MS: 10,
  STEP_DELAY_RANGE_MS: 20,
};

const SCROLL = {
  DIST_MIN_FRAC: 0.25,      // per-gesture distance: at least this …
  DIST_RANGE_FRAC: 0.4,     // … plus up to this × viewport height
  STEPS_MIN: 3,
  STEPS_JITTER: 3,
  STEP_PAUSE_MIN_MS: 30,
  STEP_PAUSE_RANGE_MS: 60,
  FIRST_PAUSE_MIN_MS: 800,  // longer "orient yourself" pause after the first scroll
  FIRST_PAUSE_RANGE_MS: 600,
  NEXT_PAUSE_MIN_MS: 300,
  NEXT_PAUSE_RANGE_MS: 500,
};

const COOKIE_SETTLE_MS = 500; // post-click settle (scaled by session speed)

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Simulate human-like mouse movement using quadratic Bézier curves.
 * Moves from a random start point to a random end point with natural acceleration.
 */
export async function humanMouseMove(page) {
  const { viewport: vp, behavior: b } = getSessionProfile();
  const mX = vp.width * EDGE_MARGIN_FRAC;
  const mY = vp.height * EDGE_MARGIN_FRAC;

  const startX = mX + Math.random() * (vp.width * MOUSE.START_X_FRAC);
  const startY = mY + Math.random() * (vp.height * MOUSE.START_Y_FRAC);
  const endX = clamp(startX + (Math.random() - 0.5) * vp.width * MOUSE.DX_FRAC * b.jitter, mX, vp.width - mX);
  const endY = clamp(startY + vp.height * MOUSE.DY_MIN_FRAC + Math.random() * vp.height * MOUSE.DY_RANGE_FRAC, mY, vp.height - mY);
  const cpX = (startX + endX) / 2 + (Math.random() - 0.5) * vp.width * MOUSE.CP_X_FRAC * b.jitter;
  const cpY = (startY + endY) / 2 + (Math.random() - 0.5) * vp.height * MOUSE.CP_Y_FRAC * b.jitter;

  const steps = MOUSE.STEPS_MIN + Math.floor(Math.random() * MOUSE.STEPS_JITTER);
  for (let i = 0; i <= steps; i++) {
    if (page.isClosed()) return;
    const t = i / steps;
    const x = Math.round((1 - t) ** 2 * startX + 2 * (1 - t) * t * cpX + t ** 2 * endX);
    const y = Math.round((1 - t) ** 2 * startY + 2 * (1 - t) * t * cpY + t ** 2 * endY);
    try {
      await page.mouse.move(x, y);
    } catch { return; }
    const delay = (MOUSE.STEP_DELAY_MIN_MS + Math.random() * MOUSE.STEP_DELAY_RANGE_MS * (1 + Math.sin(Math.PI * t))) * b.speed;
    await new Promise(r => setTimeout(r, delay));
  }
}

/**
 * Simulate human-like scrolling with momentum, variable distances, and pauses.
 * Per-gesture distance is a fraction of the viewport, bounded by how much the
 * page can actually scroll (with a one-viewport overshoot so lazy-loading grids
 * still get nudged past their current bottom). A short page therefore gets
 * fewer/gentler scrolls; a tall one gets the full set.
 */
export async function humanScroll(page, scrolls = 3) {
  await humanMouseMove(page);
  const { viewport: vp, behavior: b } = getSessionProfile();

  // Measure the page's scrollable extent so distance scales to CONTENT, not a guess.
  let geom = { innerHeight: vp.height, scrollHeight: vp.height, scrollY: 0 };
  try {
    geom = await page.evaluate(() => ({
      innerHeight: window.innerHeight,
      scrollHeight: document.body?.scrollHeight || document.documentElement?.scrollHeight || window.innerHeight,
      scrollY: window.scrollY || 0,
    }));
  } catch { /* navigated mid-call — fall back to viewport defaults */ }

  const vh = geom.innerHeight || vp.height;
  // Remaining scrollable distance + one viewport of overshoot allowance.
  let budget = Math.max(geom.scrollHeight - vh - geom.scrollY, 0) + vh;

  for (let i = 0; i < scrolls && budget > 0; i++) {
    let distance = vh * (SCROLL.DIST_MIN_FRAC + Math.random() * SCROLL.DIST_RANGE_FRAC) * b.scrollDepth;
    distance = Math.min(distance, budget);
    budget -= distance;

    const steps = SCROLL.STEPS_MIN + Math.floor(Math.random() * SCROLL.STEPS_JITTER);
    for (let s = 0; s < steps; s++) {
      if (page.isClosed()) return;
      const fraction = distance / steps * (1 - s / (steps * 2));
      try {
        await page.evaluate((d) => window.scrollBy(0, d), Math.round(fraction));
      } catch { return; }
      await new Promise(r => setTimeout(r, (SCROLL.STEP_PAUSE_MIN_MS + Math.random() * SCROLL.STEP_PAUSE_RANGE_MS) * b.speed));
    }

    const pauseMs = (i === 0
      ? SCROLL.FIRST_PAUSE_MIN_MS + Math.random() * SCROLL.FIRST_PAUSE_RANGE_MS
      : SCROLL.NEXT_PAUSE_MIN_MS + Math.random() * SCROLL.NEXT_PAUSE_RANGE_MS) * b.speed;
    await new Promise(r => setTimeout(r, pauseMs));
  }
}

/**
 * Dismiss common cookie consent / privacy banners.
 * Tries multiple known selectors and clicks the first match.
 */
export async function dismissCookieBanner(page) {
  const selectors = [
    // Generic GDPR / cookie consent buttons
    'button[id*="accept"]',
    'button[id*="consent"]',
    'button[class*="accept"]',
    'button[class*="consent"]',
    '[data-testid="gdpr-banner-accept"]',
    '#onetrust-accept-btn-handler',
    '.fc-cta-consent',
    // eBay specific
    '#gdpr-banner-accept',
    // Google consent
    'button[aria-label="Accept all"]',
    'form[action*="consent"] button',
  ];

  const { behavior: b } = getSessionProfile();
  for (const sel of selectors) {
    if (page.isClosed()) return false;
    try {
      const btn = await page.$(sel);
      if (btn) {
        await btn.click();
        await new Promise(r => setTimeout(r, COOKIE_SETTLE_MS * b.speed));
        return true;
      }
    } catch { /* selector not found or action failed, continue */ }
  }
  return false;
}
