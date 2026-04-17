import { getSessionProfile } from './antiDetectProfiles.js';

/**
 * Simulate human-like mouse movement using quadratic Bézier curves.
 * Moves from a random start point to a random end point with natural acceleration.
 */
export async function humanMouseMove(page) {
  const vp = getSessionProfile().viewport;
  const startX = 100 + Math.random() * (vp.width / 2);
  const startY = 100 + Math.random() * (vp.height / 3);
  const endX = startX + (Math.random() - 0.5) * 400;
  const endY = startY + 200 + Math.random() * 300;
  const cpX = (startX + endX) / 2 + (Math.random() - 0.5) * 200;
  const cpY = (startY + endY) / 2 + (Math.random() - 0.5) * 100;

  const steps = 15 + Math.floor(Math.random() * 10);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = Math.round((1 - t) ** 2 * startX + 2 * (1 - t) * t * cpX + t ** 2 * endX);
    const y = Math.round((1 - t) ** 2 * startY + 2 * (1 - t) * t * cpY + t ** 2 * endY);
    await page.mouse.move(x, y);
    const delay = 10 + Math.random() * 20 * (1 + Math.sin(Math.PI * t));
    await new Promise(r => setTimeout(r, delay));
  }
}

/**
 * Simulate human-like scrolling with momentum, variable distances, and pauses.
 */
export async function humanScroll(page, scrolls = 3) {
  await humanMouseMove(page);

  for (let i = 0; i < scrolls; i++) {
    const distance = 200 + Math.floor(Math.random() * 400);
    const steps = 3 + Math.floor(Math.random() * 3);
    for (let s = 0; s < steps; s++) {
      const fraction = distance / steps * (1 - s / (steps * 2));
      await page.evaluate((d) => window.scrollBy(0, d), Math.round(fraction));
      await new Promise(r => setTimeout(r, 30 + Math.random() * 60));
    }

    const pauseMs = i === 0
      ? 800 + Math.random() * 600
      : 300 + Math.random() * 500;
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

  for (const sel of selectors) {
    try {
      const btn = await page.$(sel);
      if (btn) {
        await btn.click();
        await new Promise(r => setTimeout(r, 500));
        return true;
      }
    } catch { /* selector not found, continue */ }
  }
  return false;
}
